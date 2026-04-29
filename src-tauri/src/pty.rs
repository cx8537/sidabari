use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

// 사양서 §3.1 / §4.2 — 좌측 메인 Claude Code, 중앙 상단 추가 Claude Code 탭들의 로컬 pty 토대.
// Windows ConPTY / Unix pty 추상화는 portable-pty가 처리.
// 보안 (CLAUDE.md §1.2.2): 사용자가 자기 PC에서 실행하는 명령이지만,
// 셸 인젝션 방지 위해 명령은 문자열 조합 X — CommandBuilder의 prog/args 분리 사용.

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Debug, Deserialize)]
pub struct SpawnOptions {
    // frontend가 사전 생성한 ID — listen 등록 후 spawn하기 위한 race 방지 패턴.
    // 미지정 시 backend가 새로 생성.
    #[serde(default)]
    pub session_id: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub cols: Option<u16>,
}

#[derive(Debug, Serialize, Clone)]
struct ExitPayload {
    session_id: String,
    code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
struct DataPayload {
    session_id: String,
    chunk: String,
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        // PowerShell 7(pwsh) 우선, 없으면 cmd.exe로 폴백 — 단순화 위해 PATH 의존.
        // pwsh가 설치 안 되어있으면 spawn 단계에서 에러 → 사용자에게 표시 후 cmd.exe 재시도는 안 함 (사양서 §1.3 자동 재시도 금지 정신).
        ("cmd.exe".to_string(), Vec::new())
    } else if let Ok(shell) = std::env::var("SHELL") {
        (shell, Vec::new())
    } else {
        ("/bin/bash".to_string(), Vec::new())
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Arc<PtyState>>,
    opts: SpawnOptions,
) -> Result<String, String> {
    let rows = opts.rows.unwrap_or(30);
    let cols = opts.cols.unwrap_or(120);
    let size = pty_size(rows, cols);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty 실패: {}", e))?;

    // 빈 command는 "OS 기본 셸"로 해석.
    let (program, default_args) = if opts.command.trim().is_empty() {
        default_shell()
    } else {
        (opts.command.clone(), Vec::new())
    };

    let mut cmd = CommandBuilder::new(&program);
    if opts.args.is_empty() {
        for a in default_args {
            cmd.arg(a);
        }
    } else {
        for arg in &opts.args {
            cmd.arg(arg);
        }
    }
    let cwd_resolved = match &opts.cwd {
        Some(c) if !c.trim().is_empty() => Some(c.clone()),
        _ => app
            .path()
            .home_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
    };
    if let Some(cwd) = &cwd_resolved {
        cmd.cwd(cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn 실패 ({}): {}", program, e))?;
    drop(pair.slave); // slave fd는 child가 갖는다; 마스터 측에서만 통신

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer 가져오기 실패: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader clone 실패: {}", e))?;

    let session_id = opts
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // stdout 읽기 스레드 — Read 추상은 blocking이므로 native thread 사용.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let payload = DataPayload {
                            session_id: session_id.clone(),
                            chunk,
                        };
                        if app
                            .emit(&format!("pty:data:{}", session_id), payload)
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[pty {}] read error: {}", session_id, e);
                        break;
                    }
                }
            }
        });
    }

    // child 종료 감시 스레드 — 종료 시 exit 이벤트 + 세션 정리.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let state = state.inner().clone();
        thread::spawn(move || {
            // child를 직접 wait하려면 lock 필요. 별도 wait_for_exit 사용 가능 시 더 좋지만
            // portable-pty는 try_wait/wait를 Child trait에 제공.
            loop {
                let try_result = {
                    let mut sessions = state.sessions.lock().unwrap();
                    if let Some(s) = sessions.get_mut(&session_id) {
                        s.child.try_wait()
                    } else {
                        return; // 세션이 이미 제거됨
                    }
                };
                match try_result {
                    Ok(Some(status)) => {
                        let code = status.exit_code() as i32;
                        let _ = app.emit(
                            &format!("pty:exit:{}", session_id),
                            ExitPayload {
                                session_id: session_id.clone(),
                                code: Some(code),
                            },
                        );
                        // 정리
                        let _ = state.sessions.lock().unwrap().remove(&session_id);
                        return;
                    }
                    Ok(None) => thread::sleep(std::time::Duration::from_millis(150)),
                    Err(e) => {
                        eprintln!("[pty {}] wait error: {}", session_id, e);
                        let _ = app.emit(
                            &format!("pty:exit:{}", session_id),
                            ExitPayload {
                                session_id: session_id.clone(),
                                code: None,
                            },
                        );
                        let _ = state.sessions.lock().unwrap().remove(&session_id);
                        return;
                    }
                }
            }
        });
    }

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    Ok(session_id)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, Arc<PtyState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session {} 없음", session_id))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write 실패: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("flush 실패: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, Arc<PtyState>>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("session {} 없음", session_id))?;
    session
        .master
        .resize(pty_size(rows, cols))
        .map_err(|e| format!("resize 실패: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Arc<PtyState>>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

