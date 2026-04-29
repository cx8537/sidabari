use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Deserialize;
use tauri::{AppHandle, State};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{establish_handle, SshState};

// 사양서 §3.2 [2] jar 업로드 단계용 SFTP IPC.
// 매 호출마다 별도 SSH connection (호스트 키는 known_hosts 파일 hit으로 모달 X).
// 1인용 도구라 connection 재사용 최적화는 불필요.
// 보안: 호스트 키 검증 흐름은 ssh.rs::establish_handle을 재사용 (CLAUDE.md §1.2.3).

#[derive(Debug, Deserialize)]
pub struct UploadOptions {
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
    state: State<'_, Arc<SshState>>,
    opts: UploadOptions,
) -> Result<u64, String> {
    let state_arc = state.inner().clone();

    let mut handle = establish_handle(
        &app,
        &state_arc,
        &opts.host,
        opts.port,
        &opts.user,
        &opts.private_key_path,
    )
    .await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("채널 열기 실패: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem 요청 실패: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP 세션 시작 실패: {}", e))?;

    let mut local = File::open(&opts.local_path)
        .await
        .map_err(|e| format!("로컬 파일 열기 실패 ({}): {}", opts.local_path, e))?;

    let mut remote = sftp
        .create(&opts.remote_path)
        .await
        .map_err(|e| format!("원격 파일 생성 실패 ({}): {}", opts.remote_path, e))?;

    let mut total: u64 = 0;
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| format!("로컬 read 실패: {}", e))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("원격 write 실패: {}", e))?;
        total += n as u64;
    }
    remote
        .shutdown()
        .await
        .map_err(|e| format!("원격 shutdown 실패: {}", e))?;

    sftp.close()
        .await
        .map_err(|e| format!("sftp close 실패: {}", e))?;

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "client closing", "")
        .await;

    Ok(total)
}
