use std::sync::Arc;

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::ssh::{establish_handle, SshState};

// 사양서 §3.2 [3] / [4] — deploy.sh, monitor 등 EC2에서 단일 명령을 실행하고
// stdout/stderr를 라인 단위로 stream + exit code 받는 IPC.
// 메인 SSH 셸 채널과 분리된 exec 채널 — 종료 감지가 명확하다.

#[derive(Debug, Deserialize)]
pub struct ExecOptions {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub private_key_path: String,
    pub command: String,
}

fn default_port() -> u16 {
    22
}

#[derive(Debug, Serialize, Clone)]
struct LinePayload {
    exec_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Debug, Serialize, Clone)]
struct DonePayload {
    exec_id: String,
    exit_code: Option<i32>,
    succeeded: bool,
    reason: String,
}

fn flush_complete_lines(
    buf: &mut Vec<u8>,
    stream: &'static str,
    exec_id: &str,
    app: &AppHandle,
) {
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let mut line_bytes: Vec<u8> = buf.drain(..=pos).collect();
        // \n과 직전 \r 제거
        line_bytes.pop();
        if line_bytes.last() == Some(&b'\r') {
            line_bytes.pop();
        }
        let line = String::from_utf8_lossy(&line_bytes).to_string();
        let _ = app.emit(
            &format!("ssh-exec:line:{}", exec_id),
            LinePayload {
                exec_id: exec_id.to_string(),
                stream,
                line,
            },
        );
    }
}

fn flush_remaining(buf: &[u8], stream: &'static str, exec_id: &str, app: &AppHandle) {
    if buf.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(buf).to_string();
    let _ = app.emit(
        &format!("ssh-exec:line:{}", exec_id),
        LinePayload {
            exec_id: exec_id.to_string(),
            stream,
            line,
        },
    );
}

#[tauri::command]
pub async fn ssh_exec(
    app: AppHandle,
    state: State<'_, Arc<SshState>>,
    opts: ExecOptions,
) -> Result<String, String> {
    let exec_id = Uuid::new_v4().to_string();
    let state_arc = state.inner().clone();

    let handle = establish_handle(
        &app,
        &state_arc,
        &opts.host,
        opts.port,
        &opts.user,
        &opts.private_key_path,
    )
    .await?;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("채널 열기 실패: {}", e))?;
    channel
        .exec(true, opts.command.as_bytes())
        .await
        .map_err(|e| format!("exec 요청 실패: {}", e))?;

    // task: ChannelMsg loop. exit_status 받고 eof/close까지 진행.
    let app_io = app.clone();
    let id_io = exec_id.clone();
    tokio::spawn(async move {
        let mut stdout_buf: Vec<u8> = Vec::new();
        let mut stderr_buf: Vec<u8> = Vec::new();
        let mut exit_code: Option<i32> = None;

        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout_buf.extend_from_slice(&data);
                    flush_complete_lines(&mut stdout_buf, "stdout", &id_io, &app_io);
                }
                Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                    stderr_buf.extend_from_slice(&data);
                    flush_complete_lines(&mut stderr_buf, "stderr", &id_io, &app_io);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        // 잔여 buffer flush (개행 없는 마지막 토막)
        flush_remaining(&stdout_buf, "stdout", &id_io, &app_io);
        flush_remaining(&stderr_buf, "stderr", &id_io, &app_io);

        let succeeded = exit_code == Some(0);
        let reason = match exit_code {
            Some(c) => format!("exit code {}", c),
            None => "no exit status (channel closed without ExitStatus)".to_string(),
        };
        let _ = app_io.emit(
            &format!("ssh-exec:done:{}", id_io),
            DonePayload {
                exec_id: id_io.clone(),
                exit_code,
                succeeded,
                reason,
            },
        );

        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "exec finished", "")
            .await;
    });

    Ok(exec_id)
}
