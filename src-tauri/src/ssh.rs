use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handler};
use russh::{ChannelMsg, Disconnect};
use russh_keys::key::PublicKey;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

// 사양서 §3.2 / §4.2 / §1.2.3 — EC2 SSH 셸 토대.
// 보안 (CLAUDE.md §1.2.3):
//  - 호스트 키 검증 활성화 (TOFU). 첫 접속 fingerprint를 frontend로 emit해 사용자 승인.
//  - 자동 수락 모드 X. 메모리 캐시(같은 세션 내 재접속만 자동) — 영구 known_hosts는 다음 stage.
//  - 자동 재시도 X (사양서 §1.3): 실패 시 즉시 멈추고 사용자에게 알림.
//  - PEM 키는 경로만 받아 파일 로드 — 키 내용은 메모리에만 (CLAUDE.md §1.2.1).

pub struct SshSession {
    out_tx: mpsc::Sender<Outbound>,
}

enum Outbound {
    Data(Vec<u8>),
    Resize { rows: u32, cols: u32 },
    Close,
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, SshSession>>,
    pending_keys: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    // host:port → fingerprint (메모리 캐시, 같은 앱 세션 동안 유효)
    accepted_fingerprints: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct ConnectOptions {
    pub session_id: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub private_key_path: String,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub cols: Option<u32>,
}

fn default_port() -> u16 {
    22
}

#[derive(Debug, Serialize, Clone)]
struct DataPayload {
    session_id: String,
    chunk: String,
}

#[derive(Debug, Serialize, Clone)]
struct ClosedPayload {
    session_id: String,
    reason: String,
}

#[derive(Debug, Serialize, Clone)]
struct HostKeyPromptPayload {
    request_id: String,
    host: String,
    port: u16,
    fingerprint: String,
}

struct ClientHandler {
    state: Arc<SshState>,
    app: AppHandle,
    host: String,
    port: u16,
}

#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = compute_fingerprint(public_key);
        let host_key = format!("{}:{}", self.host, self.port);

        // 메모리 캐시 확인 — 같은 앱 세션 동안 같은 host의 같은 키는 자동 수락.
        {
            let cache = self.state.accepted_fingerprints.lock().await;
            if let Some(saved) = cache.get(&host_key) {
                if saved == &fp {
                    return Ok(true);
                }
                eprintln!(
                    "[ssh] host key changed for {} — saved={} got={}",
                    host_key, saved, fp
                );
                return Ok(false);
            }
        }

        // 처음 보는 호스트 — frontend에 fingerprint 표시 후 사용자 승인 대기.
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.state.pending_keys.lock().await;
            pending.insert(request_id.clone(), tx);
        }

        let _ = self.app.emit(
            "ssh:host-key-prompt",
            HostKeyPromptPayload {
                request_id: request_id.clone(),
                host: self.host.clone(),
                port: self.port,
                fingerprint: fp.clone(),
            },
        );

        // 사용자가 ssh_accept_host_key invoke 시 oneshot으로 결과 수신.
        let accepted = rx.await.unwrap_or(false);
        if accepted {
            let mut cache = self.state.accepted_fingerprints.lock().await;
            cache.insert(host_key, fp);
        } else {
            // 정리
            self.state.pending_keys.lock().await.remove(&request_id);
        }
        Ok(accepted)
    }
}

fn compute_fingerprint(public_key: &PublicKey) -> String {
    // russh-keys의 fingerprint()는 SHA256 base64-nopad 반환. OpenSSH 표시 형식 그대로.
    format!("SHA256:{}", public_key.fingerprint())
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, Arc<SshState>>,
    opts: ConnectOptions,
) -> Result<String, String> {
    let session_id = opts.session_id.clone();
    let state_arc = state.inner().clone();

    // PEM 키 로드 — 메모리에만, 파일 내용 저장 X.
    let key = russh_keys::load_secret_key(&opts.private_key_path, None)
        .map_err(|e| format!("PEM 키 로드 실패 ({}): {}", opts.private_key_path, e))?;
    let key_pair = Arc::new(key);

    // 셸 세션은 idle 가능 — inactivity_timeout None.
    // (Some(Duration::ZERO)는 "0초 후 timeout"으로 해석돼 즉시 끊기므로 사용 금지.)
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        ..Default::default()
    });

    let handler = ClientHandler {
        state: state_arc.clone(),
        app: app.clone(),
        host: opts.host.clone(),
        port: opts.port,
    };

    let addr = format!("{}:{}", opts.host, opts.port);
    let mut handle = client::connect(config, addr, handler)
        .await
        .map_err(|e| format!("SSH 연결 실패: {}", e))?;

    let auth_ok = handle
        .authenticate_publickey(&opts.user, key_pair)
        .await
        .map_err(|e| format!("인증 실패: {}", e))?;
    if !auth_ok {
        return Err("인증 실패 (키 또는 사용자 불일치)".to_string());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("채널 열기 실패: {}", e))?;

    let rows = opts.rows.unwrap_or(30);
    let cols = opts.cols.unwrap_or(120);
    // want_reply=true — server가 PTY/shell 거부 시 명시적 에러로 받음 (false면 silent fail).
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("PTY 요청 실패: {}", e))?;
    eprintln!("[ssh {}] request_pty OK", opts.session_id);
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("shell 요청 실패: {}", e))?;
    eprintln!("[ssh {}] request_shell OK", opts.session_id);

    // outbound channel — JS의 write/resize/disconnect를 task에 전달
    let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(64);

    let app_io = app.clone();
    let session_io = session_id.clone();
    let state_io = state_arc.clone();
    let mut chan = channel;

    tokio::spawn(async move {
        let mut close_reason = "EOF".to_string();
        loop {
            tokio::select! {
                msg = chan.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            eprintln!("[ssh {}] data {} bytes", session_io, data.len());
                            let chunk = String::from_utf8_lossy(&data).to_string();
                            let _ = app_io.emit(
                                &format!("ssh:data:{}", session_io),
                                DataPayload { session_id: session_io.clone(), chunk },
                            );
                        }
                        Some(ChannelMsg::ExtendedData { data, ext }) => {
                            eprintln!("[ssh {}] ext-data ext={} {} bytes", session_io, ext, data.len());
                            let chunk = String::from_utf8_lossy(&data).to_string();
                            let _ = app_io.emit(
                                &format!("ssh:data:{}", session_io),
                                DataPayload { session_id: session_io.clone(), chunk },
                            );
                        }
                        Some(ChannelMsg::Eof) => {
                            eprintln!("[ssh {}] EOF", session_io);
                            close_reason = "EOF".to_string();
                            break;
                        }
                        Some(ChannelMsg::Close) => {
                            eprintln!("[ssh {}] Close", session_io);
                            close_reason = "channel closed".to_string();
                            break;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            eprintln!("[ssh {}] ExitStatus {}", session_io, exit_status);
                            close_reason = format!("exit status {}", exit_status);
                        }
                        Some(other) => {
                            eprintln!("[ssh {}] other msg: {:?}", session_io, std::mem::discriminant(&other));
                        }
                        None => {
                            eprintln!("[ssh {}] stream None", session_io);
                            close_reason = "stream ended".to_string();
                            break;
                        }
                    }
                }
                Some(out) = out_rx.recv() => {
                    match out {
                        Outbound::Data(bytes) => {
                            let _ = chan.data(&bytes[..]).await;
                        }
                        Outbound::Resize { rows, cols } => {
                            let _ = chan.window_change(cols, rows, 0, 0).await;
                        }
                        Outbound::Close => {
                            let _ = chan.eof().await;
                            let _ = chan.close().await;
                            close_reason = "user disconnect".to_string();
                            break;
                        }
                    }
                }
            }
        }
        // 정리 + frontend 알림
        let _ = state_io.sessions.lock().await.remove(&session_io);
        let _ = handle
            .disconnect(Disconnect::ByApplication, "client closing", "")
            .await;
        let _ = app_io.emit(
            &format!("ssh:closed:{}", session_io),
            ClosedPayload {
                session_id: session_io,
                reason: close_reason,
            },
        );
    });

    state_arc
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), SshSession { out_tx });

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, Arc<SshState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| format!("session {} 없음", session_id))?;
    s.out_tx
        .send(Outbound::Data(data.into_bytes()))
        .await
        .map_err(|e| format!("ssh write 전송 실패: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, Arc<SshState>>,
    session_id: String,
    rows: u32,
    cols: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| format!("session {} 없음", session_id))?;
    s.out_tx
        .send(Outbound::Resize { rows, cols })
        .await
        .map_err(|e| format!("ssh resize 전송 실패: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, Arc<SshState>>,
    session_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    if let Some(s) = sessions.get(&session_id) {
        let _ = s.out_tx.send(Outbound::Close).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_accept_host_key(
    state: State<'_, Arc<SshState>>,
    request_id: String,
    accepted: bool,
) -> Result<(), String> {
    let mut pending = state.pending_keys.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(accepted);
        Ok(())
    } else {
        Err(format!("request {} 없음 (이미 응답?)", request_id))
    }
}
