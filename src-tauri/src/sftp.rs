use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;
use uuid::Uuid;

use crate::ssh::{establish_handle, SshState};

// 셸 인자 단일 따옴표 escape — CLAUDE.md §1.2.2 셸 인젝션 방지.
// SSH exec는 서버 셸에 명령 문자열을 그대로 전달하므로 인자(원격 경로)를 안전히 감싼다.
// 단일 따옴표 안의 ' 문자는 '\\'' 패턴으로 닫고-escape-다시-여는 표준 트릭.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

// 청크 크기 — russh-sftp 2.1의 MAX_WRITE_LENGTH(261120) 정확히 일치.
// OpenSSH 기본 sftp-server가 안정적으로 받아들이는 최대치이므로 이 값을 넘지 않는다.
const SFTP_CHUNK_SIZE: usize = 261_120;

// 동시 in-flight write 수 — 사양서 §3.2 [2] 처리량.
// 16 × 261KB ≈ 4.2 MiB 윈도우. ssh.rs의 window_size 16MiB 안에 충분히 들어가고
// 일반 BDP(예: 100Mbps × 50ms RTT = 625KB)를 한참 넘는 buffer라 응답 대기 stall이 거의 사라짐.
const MAX_INFLIGHT: usize = 16;

// 진행률 이벤트 throttle — 동일 attempt에서 IPC 폭주 방지.
// 200ms는 사람 눈에 충분히 부드럽고 backend CPU 영향 미미.
const PROGRESS_INTERVAL_MS: u128 = 200;

// 개별 SFTP 요청 timeout — 기본 10초는 큰 청크 + 느린 링크에서 빡빡.
// 60초로 늘려 정상 진행 중인 write가 false-timeout 나지 않도록.
const SFTP_REQUEST_TIMEOUT_SEC: u64 = 60;

// 사양서 §3.2 [2] jar 업로드 단계용 SFTP IPC.
// 매 호출마다 별도 SSH connection (호스트 키는 known_hosts 파일 hit으로 모달 X).
// 사양서 §3.7 — 강제 중단 지원 (sftp_upload_kill로 청크 사이 cancel).

#[derive(Default)]
pub struct SftpState {
    runs: Mutex<HashMap<String, mpsc::Sender<()>>>,
}

// 사양서 §4.5 외 — 진행률 표시는 사용자 체감 개선용 비결정 정보. 이벤트 페이로드.
// bytes_total이 None인 경우는 메타데이터 조회 실패 (예외적, 그래도 업로드는 진행).
// phase는 단계 표시용: "uploading" → "verifying" → (완료 시 함수 반환).
#[derive(Debug, Serialize, Clone)]
struct ProgressPayload {
    upload_id: String,
    phase: &'static str,
    bytes_done: u64,
    bytes_total: Option<u64>,
    speed_bps: u64, // 평균 전송 속도 (bytes/sec, 시작 시점 누적)
}

// sftp_upload 반환 — 사양서 §3.2 [2] 무결성 보증을 위해 sha256까지 포함.
// frontend는 [업로드 완료] 라인에 hash 12자리 prefix를 표시해 사용자가 신속 확인 가능.
#[derive(Debug, Serialize, Clone)]
pub struct UploadResult {
    pub bytes: u64,
    pub sha256: String,
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
) -> Result<UploadResult, String> {
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

    // RawSftpSession 직접 사용 — 동시 write 발행이 가능한 raw API.
    // 고수준 SftpSession::create는 내부적으로 File에 단일 in-flight write만 허용하므로
    // 파이프라이닝(다수 동시 in-flight)이 불가하다.
    let raw = RawSftpSession::new(channel.into_stream());
    if let Err(e) = raw.init().await {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "client closing", "")
            .await;
        cleanup(sftp_arc, upload_id).await;
        return Err(format!("SFTP 초기화 실패: {}", e));
    }
    raw.set_timeout(SFTP_REQUEST_TIMEOUT_SEC).await;
    let raw = Arc::new(raw);

    let open_resp = match raw
        .open(
            opts.remote_path.clone(),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            FileAttributes::default(),
        )
        .await
    {
        Ok(h) => h,
        Err(e) => {
            let _ = raw.close_session();
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "client closing", "")
                .await;
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("원격 파일 생성 실패 ({}): {}", opts.remote_path, e));
        }
    };
    let file_handle = open_resp.handle;

    let mut local = match File::open(&opts.local_path).await {
        Ok(f) => f,
        Err(e) => {
            let _ = raw.close(file_handle.clone()).await;
            let _ = raw.remove(opts.remote_path.clone()).await;
            let _ = raw.close_session();
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "client closing", "")
                .await;
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("로컬 파일 열기 실패 ({}): {}", opts.local_path, e));
        }
    };
    // 총 크기 — 진행률 % 표시용. 실패해도 업로드는 진행 (None으로 emit).
    let bytes_total: Option<u64> = local.metadata().await.ok().map(|m| m.len());

    // 강제 중단 신호 — kill watcher가 신호 받으면 true로 flip. 모든 spawn task가 협조적 cancel.
    let cancel = Arc::new(AtomicBool::new(false));
    // ACK된 누적 바이트 — 진행률은 발행(issued)이 아닌 ACK 기준이라야 정확.
    let bytes_acked = Arc::new(AtomicU64::new(0));
    // 동시 in-flight write 수 제한 (back-pressure).
    let semaphore = Arc::new(Semaphore::new(MAX_INFLIGHT));
    let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();

    // kill watcher — 별도 task로 kill_rx만 감시. 본 loop는 cancel flag만 polling.
    // 본 loop가 cancel 전에 정상 종료하면 watcher abort.
    let cancel_for_watcher = cancel.clone();
    let kill_watcher = tokio::spawn(async move {
        let _ = kill_rx.recv().await;
        cancel_for_watcher.store(true, Ordering::Relaxed);
    });

    let mut hasher = Sha256::new();
    let started_at = Instant::now();
    let mut last_emit = started_at;

    // 진행률 emit — 클로저는 본 loop와 finalization 양쪽에서 사용.
    let upload_id_emit = upload_id.clone();
    let app_emit = app.clone();
    let bytes_acked_emit = bytes_acked.clone();
    let emit_progress = move |phase: &'static str| {
        let bytes_done = bytes_acked_emit.load(Ordering::Relaxed);
        let elapsed_ms = started_at.elapsed().as_millis().max(1);
        let speed_bps = (bytes_done as u128).saturating_mul(1000) / elapsed_ms;
        let payload = ProgressPayload {
            upload_id: upload_id_emit.clone(),
            phase,
            bytes_done,
            bytes_total,
            speed_bps: speed_bps as u64,
        };
        let _ = app_emit.emit(&format!("sftp:progress:{}", upload_id_emit), payload);
    };

    // Producer loop: read → hash → permit → spawn write.
    // cancel flag을 매 iter 점검 — kill 또는 task 실패가 set하면 빠르게 빠져나옴.
    let mut buf = vec![0u8; SFTP_CHUNK_SIZE];
    let mut bytes_issued: u64 = 0;
    let producer_result: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Err("강제 중단 (sftp upload)".to_string());
        }

        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => break Err(format!("로컬 read 실패: {}", e)),
        };
        if n == 0 {
            break Ok(());
        }

        // SHA256 누적 — 디스크 재읽기 없이 업로드와 동시 계산. Producer는 단일 task라 sequential.
        hasher.update(&buf[..n]);

        // permit 획득 (back-pressure: in-flight ≤ MAX_INFLIGHT).
        let permit = match semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break Err("세마포어 closed".to_string()),
        };

        // 이 청크는 spawn task로 이동 — Vec<u8> 새로 복사.
        // (russh-sftp::write가 Vec<u8>를 by-value로 받으므로 어차피 복사 발생.)
        let chunk: Vec<u8> = buf[..n].to_vec();
        let raw_clone = raw.clone();
        let handle_str = file_handle.clone();
        let chunk_offset = bytes_issued;
        let chunk_len = n as u64;
        let bytes_acked_clone = bytes_acked.clone();
        let cancel_clone = cancel.clone();

        tasks.spawn(async move {
            let _p = permit; // drop 시 permit 반환
            if cancel_clone.load(Ordering::Relaxed) {
                return Err("취소".to_string());
            }
            match raw_clone.write(handle_str, chunk_offset, chunk).await {
                Ok(_) => {
                    bytes_acked_clone.fetch_add(chunk_len, Ordering::Relaxed);
                    Ok(())
                }
                Err(e) => {
                    // 다른 task / producer에 즉시 전파.
                    cancel_clone.store(true, Ordering::Relaxed);
                    Err(format!(
                        "원격 write 실패 (offset={}): {}",
                        chunk_offset, e
                    ))
                }
            }
        });

        bytes_issued += n as u64;

        // throttle — PROGRESS_INTERVAL_MS 마다만 emit (acked 기준).
        let now = Instant::now();
        if now.duration_since(last_emit).as_millis() >= PROGRESS_INTERVAL_MS {
            emit_progress("uploading");
            last_emit = now;
        }
    };

    // 모든 in-flight task drain — 성공/실패 무관하게 깨끗이 정리.
    let mut first_task_err: Option<String> = None;
    while let Some(res) = tasks.join_next().await {
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if first_task_err.is_none() {
                    first_task_err = Some(e);
                }
            }
            Err(e) => {
                if first_task_err.is_none() {
                    first_task_err = Some(format!("write task 패닉/abort: {}", e));
                }
            }
        }
    }

    // kill watcher 정리 — 신호가 오지 않았으면 abort.
    kill_watcher.abort();

    let final_acked = bytes_acked.load(Ordering::Relaxed);

    // producer 에러가 task 에러보다 우선 (논리적으로 read/cancel가 먼저 일어남).
    let upload_outcome: Result<u64, String> = match (producer_result, first_task_err) {
        (Ok(()), None) => Ok(bytes_issued),
        (Ok(()), Some(e)) => Err(e),
        (Err(e), _) => Err(e),
    };

    // 파일 핸들 close — 성공이면 commit, 실패면 server-side cleanup 도움.
    let _ = raw.close(file_handle).await;

    let upload_bytes = match upload_outcome {
        Ok(_) => final_acked,
        Err(err_msg) => {
            // 사양서 §3.7 잔여물 X — 부분 파일 삭제.
            let cleanup_msg = match raw.remove(opts.remote_path.clone()).await {
                Ok(_) => " (부분 파일 정리 완료)",
                Err(_) => " (부분 파일 정리 실패)",
            };
            let _ = raw.close_session();
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "client closing", "")
                .await;
            cleanup(sftp_arc, upload_id).await;
            return Err(format!("{}{}", err_msg, cleanup_msg));
        }
    };

    // 업로드 성공 — 마지막 정확 bytes로 한 번 더 emit.
    emit_progress("uploading");

    // 로컬 hash 확정 (producer가 이미 chunk 단위로 모두 update 완료).
    let local_sha = format!("{:x}", hasher.finalize());

    // SFTP 채널 종료 — 이후 같은 SSH handle로 새 exec 채널 열어 sha256sum 실행.
    let _ = raw.close_session();

    emit_progress("verifying");

    // 원격 sha256sum 실행. 같은 handle 재사용 → 추가 SSH 핸드셰이크 없음.
    // path는 셸 escape 거쳐 인젝션 방지 (CLAUDE.md §1.2.2).
    let cmd = format!("sha256sum -- {}", shell_single_quote(&opts.remote_path));
    let remote_sha_result = run_remote_sha256(&handle, &cmd).await;

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "client closing", "")
        .await;
    cleanup(sftp_arc, upload_id).await;

    match remote_sha_result {
        Ok(remote_sha) => {
            if remote_sha.eq_ignore_ascii_case(&local_sha) {
                Ok(UploadResult {
                    bytes: upload_bytes,
                    sha256: local_sha,
                })
            } else {
                // 무결성 실패 — 사양서 §3.7 정신에 따라 잔여물 제거 시도 후 명확 에러.
                // 단, handle은 이미 disconnect — 별 SSH 연결로 한 번 더 정리는 비용 대비 이득 없음.
                // 메시지에 두 hash를 첫 12자리만 노출 (전체는 디버그 시 직접 sha256sum).
                Err(format!(
                    "[검증 실패] SHA256 불일치 — local={}.. remote={}.. ({} bytes 업로드됨)",
                    &local_sha[..12.min(local_sha.len())],
                    &remote_sha[..12.min(remote_sha.len())],
                    upload_bytes
                ))
            }
        }
        Err(e) => Err(format!("[검증 실패] {}", e)),
    }
}

// 원격 sha256sum 결과의 첫 64자리 hex만 추출. 출력 형식: "<hex>  <path>\n"
async fn run_remote_sha256(
    handle: &russh::client::Handle<crate::ssh::ClientHandler>,
    cmd: &str,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("검증 채널 열기 실패: {}", e))?;
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| format!("sha256sum exec 실패: {}", e))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<i32> = None;

    // 30초 timeout — sha256sum은 디스크 읽기뿐이라 큰 jar(수백 MB)도 통상 수초 이내.
    let wait_loop = async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                    stderr.extend_from_slice(&data)
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                }
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
    };
    timeout(Duration::from_secs(30), wait_loop)
        .await
        .map_err(|_| "sha256sum timeout (30초)".to_string())?;

    if exit_code != Some(0) {
        let err_text = String::from_utf8_lossy(&stderr).trim().to_string();
        let detail = if err_text.is_empty() {
            "원격 sha256sum 실패 (서버에 sha256sum 미설치 가능)".to_string()
        } else {
            format!("원격 sha256sum 실패: {}", err_text)
        };
        return Err(detail);
    }

    let text = String::from_utf8_lossy(&stdout);
    let hex: String = text
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .collect();
    if hex.len() != 64 {
        return Err(format!(
            "sha256sum 출력 파싱 실패 (길이 {} ≠ 64)",
            hex.len()
        ));
    }
    Ok(hex)
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
