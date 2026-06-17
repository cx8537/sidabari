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
    // Phase 0 — 훅 식별을 위한 SIDABARI_PANEL_ID 등 ENV 주입용.
    #[serde(default)]
    pub env: HashMap<String, String>,
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

// Windows에서 PATH + PATHEXT로 program을 해소.
// 호출자가 "claude"처럼 확장자 없는 이름을 보내면 npm shim의 실체(claude.cmd)를 찾아
// CreateProcessW가 spawn할 수 있는 형태로 래핑한다.
//
// 반환: (실제 spawn할 program, args 앞에 prepend할 항목들).
// - `.exe` / 절대 경로의 PE → 그대로
// - `.cmd` / `.bat`         → ("cmd.exe", ["/c", resolved])
// - `.ps1`                  → ("powershell.exe", ["-File", resolved])
// - PATH 해소 실패           → 원본 그대로 (기존 동작 유지)
//
// 보안 (CLAUDE.md §1.2.2): 사용자 입력을 셸 명령 문자열로 조합하지 않는다.
// 여기서도 CommandBuilder가 args를 개별 인자로 받아 CreateProcessW에 직접 전달 — 셸 인터프리테이션 경로 없음.
#[cfg(windows)]
fn resolve_windows_program(program: &str) -> (String, Vec<String>) {
    let lower = program.to_lowercase();
    // 이미 PE 실행파일이면 PATH 해소 불필요.
    if lower.ends_with(".exe") {
        return (program.to_string(), Vec::new());
    }

    let resolved = match find_on_path(program) {
        Some(p) => p,
        None => return (program.to_string(), Vec::new()),
    };
    let rl = resolved.to_lowercase();
    if rl.ends_with(".cmd") || rl.ends_with(".bat") {
        ("cmd.exe".to_string(), vec!["/c".to_string(), resolved])
    } else if rl.ends_with(".ps1") {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-File".to_string(),
                resolved,
            ],
        )
    } else {
        // 확장자 없는 PE 또는 .com 등 — 그대로
        (resolved, Vec::new())
    }
}

#[cfg(not(windows))]
fn resolve_windows_program(program: &str) -> (String, Vec<String>) {
    (program.to_string(), Vec::new())
}

#[cfg(windows)]
fn find_on_path(name: &str) -> Option<String> {
    let has_sep = name.contains('\\') || name.contains('/');
    let has_ext = std::path::Path::new(name).extension().is_some();
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<String> = pathext
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    // 절대/상대 경로가 명시된 경우엔 PATH 탐색 없이 그 위치만 확장자 보강.
    if has_sep {
        let base = std::path::PathBuf::from(name);
        if has_ext && base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
        if !has_ext {
            for ext in &exts {
                let candidate = std::path::PathBuf::from(format!("{}{}", name, ext));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        return None;
    }

    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if has_ext {
            let direct = dir.join(name);
            if direct.is_file() {
                return Some(direct.to_string_lossy().into_owned());
            }
        } else {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", name, ext));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
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
    // Windows에서 "claude" 같은 npm shim은 PATH + PATHEXT로 실체(claude.cmd)를 찾아
    // cmd.exe /c 로 래핑한다 — 그래야 CreateProcessW(error 193: 올바른 Win32 응용 프로그램이 아님)를 피한다.
    let (program, prepend_args, default_args) = if opts.command.trim().is_empty() {
        let (p, da) = default_shell();
        (p, Vec::new(), da)
    } else {
        let (p, pre) = resolve_windows_program(opts.command.trim());
        (p, pre, Vec::new())
    };

    let mut cmd = CommandBuilder::new(&program);
    for a in &prepend_args {
        cmd.arg(a);
    }
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
    // Phase 0 — 사용자 지정 ENV (SIDABARI_PANEL_ID 등) 주입.
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        if program == opts.command || opts.command.trim().is_empty() {
            format!("spawn 실패 ({}): {}", program, e)
        } else {
            format!("spawn 실패 ({} → {}): {}", opts.command, program, e)
        }
    })?;
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

