use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Deserialize;
use tauri::{AppHandle, State};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::ssh::{establish_handle, SshState};

// 사양서 §3.2 [2] jar 업로드 단계용 SFTP IPC.
// 매 호출마다 별도 SSH connection (호스트 키는 known_hosts 파일 hit으로 모달 X).
// 사양서 §3.7 — 강제 중단 지원 (sftp_upload_kill로 청크 사이 cancel).

#[derive(Default)]
pub struct SftpState {
    runs: Mutex<HashMap<String, mpsc::Sender<()>>>,
}

#[derive(Debug, Deserialize)]
pub struct UploadOptions {
    #[serde(default)]
    pub upload_id: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub private_key_path: String,
    pub local_path: String,
    pub remote_path: String,
}

fn default_port() -> u16 {
    22
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    sftp_state: State<'_, Arc<SftpState>>,
    ssh_state: State<'_, Arc<SshState>>,
    opts: UploadOptions,
) -> Result<u64, String> {
    let upload_id = opts
        .upload_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let ssh_arc = ssh_state.inner().clone();
    let sftp_arc = sftp_state.inner().clone();

    // kill 채널 등록 — sftp_upload_kill에서 신호 보냄
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);
    sftp_arc
        .runs
        .lock()
        .await
        .insert(upload_id.clone(), kill_tx);

    // 정리 helper — 등록 제거 (early return / 모든 exit 경로에서 호출)
    let cleanup = |sftp_arc: Arc<SftpState>, upload_id: String| async move {
        let _ = sftp_arc.runs.lock().await.remove(&upload_id);
    };

    let handle = match establish_handle(
        &app,
        &ssh_arc,
        &opts.host,
        opts.port,
        &opts.user,
        &opts.private_key_path,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            cleanup(sftp_arc, upload_id).await;
            return Err(e);
        }
    };

    let channel = match handle.channel_open_session().await {
        Ok(c) => c,
        Err(e) => {
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("채널 열기 실패: {}", e));
        }
    };
    if let Err(e) = channel.request_subsystem(true, "sftp").await {
        cleanup(sftp_arc, upload_id).await;
        return Err(format!("sftp subsystem 요청 실패: {}", e));
    }

    let sftp = match SftpSession::new(channel.into_stream()).await {
        Ok(s) => s,
        Err(e) => {
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("SFTP 세션 시작 실패: {}", e));
        }
    };

    let mut local = match File::open(&opts.local_path).await {
        Ok(f) => f,
        Err(e) => {
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("로컬 파일 열기 실패 ({}): {}", opts.local_path, e));
        }
    };
    let mut remote = match sftp.create(&opts.remote_path).await {
        Ok(r) => r,
        Err(e) => {
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("원격 파일 생성 실패 ({}): {}", opts.remote_path, e));
        }
    };

    let mut total: u64 = 0;
    let mut buf = vec![0u8; 32 * 1024];

    let result: Result<u64, String> = loop {
        // 매 read/write 라운드 사이에 kill 신호 체크 (사양서 §3.7 강제 중단).
        tokio::select! {
            r = local.read(&mut buf) => {
                let n = match r {
                    Ok(n) => n,
                    Err(e) => break Err(format!("로컬 read 실패: {}", e)),
                };
                if n == 0 {
                    break Ok(total);
                }
                if let Err(e) = remote.write_all(&buf[..n]).await {
                    break Err(format!("원격 write 실패: {}", e));
                }
                total += n as u64;
            }
            _ = kill_rx.recv() => {
                break Err("강제 중단 (sftp upload)".to_string());
            }
        }
    };

    // 파일 핸들은 항상 정리. 실패/abort면 부분 파일도 서버에서 삭제 (사양서 §3.7 — 잔여물 X).
    let _ = remote.shutdown().await;
    let final_result = match result {
        Ok(n) => Ok(n),
        Err(err_msg) => {
            let cleanup_msg = match sftp.remove_file(&opts.remote_path).await {
                Ok(()) => " (부분 파일 정리 완료)",
                Err(_) => " (부분 파일 정리 실패)",
            };
            Err(format!("{}{}", err_msg, cleanup_msg))
        }
    };
    let _ = sftp.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "client closing", "")
        .await;
    cleanup(sftp_arc, upload_id).await;

    final_result
}

#[tauri::command]
pub async fn sftp_upload_kill(
    state: State<'_, Arc<SftpState>>,
    upload_id: String,
) -> Result<(), String> {
    let runs = state.runs.lock().await;
    if let Some(tx) = runs.get(&upload_id) {
        let _ = tx.send(()).await;
    }
    Ok(())
}
