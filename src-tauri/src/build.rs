use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

// 사양서 §3.2 [1] 빌드 단계.
// 보안 (CLAUDE.md §1.2.2): build_command는 사용자가 의도적으로 입력한 셸 명령.
// 셸로 wrap하지만 사용자 자신이 자기 PC에서 실행. [시도 시작] 클릭이 명시적 승인 게이트.

#[derive(Default)]
pub struct BuildState {
    runs: Mutex<HashMap<String, BuildRun>>,
}

struct BuildRun {
    child: Child,
}

#[derive(Debug, Deserialize)]
pub struct BuildOptions {
    pub command: String,
    pub working_directory: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    300
}

#[derive(Debug, Serialize, Clone)]
struct LinePayload {
    attempt_id: String,
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Debug, Serialize, Clone)]
struct DonePayload {
    attempt_id: String,
    exit_code: Option<i32>,
    succeeded: bool,
    reason: String,
}

#[tauri::command]
pub async fn build_start(
    app: AppHandle,
    state: State<'_, Arc<BuildState>>,
    opts: BuildOptions,
) -> Result<String, String> {
    let attempt_id = Uuid::new_v4().to_string();

    if opts.command.trim().is_empty() {
        return Err("빌드 명령이 비어있음".to_string());
    }
    let cwd = PathBuf::from(&opts.working_directory);
    if !cwd.is_dir() {
        return Err(format!(
            "빌드 작업 디렉토리가 존재하지 않거나 폴더가 아님: {}",
            opts.working_directory
        ));
    }

    // OS 셸로 wrap — 사용자가 .bat/스크립트/리다이렉션 등 자유롭게 사용.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &opts.command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &opts.command]);
        c
    };
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("빌드 spawn 실패: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe 누락".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe 누락".to_string())?;

    // stdout 라인 stream
    {
        let app = app.clone();
        let id = attempt_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit(
                    &format!("build:line:{}", id),
                    LinePayload {
                        attempt_id: id.clone(),
                        stream: "stdout",
                        line,
                    },
                );
            }
        });
    }
    // stderr 라인 stream
    {
        let app = app.clone();
        let id = attempt_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit(
                    &format!("build:line:{}", id),
                    LinePayload {
                        attempt_id: id.clone(),
                        stream: "stderr",
                        line,
                    },
                );
            }
        });
    }

    // 종료 감시 (timeout 포함). 끝나면 done emit + state 정리.
    {
        let app = app.clone();
        let id = attempt_id.clone();
        let state_arc = state.inner().clone();
        let timeout = Duration::from_secs(opts.timeout_seconds.max(1));
        tokio::spawn(async move {
            let wait_fut = async {
                let status_result = {
                    let mut runs = state_arc.runs.lock().await;
                    if let Some(run) = runs.get_mut(&id) {
                        run.child.wait().await
                    } else {
                        return None;
                    }
                };
                Some(status_result)
            };
            let outcome = tokio::time::timeout(timeout, wait_fut).await;
            let payload = match outcome {
                Ok(Some(Ok(status))) => {
                    let code = status.code();
                    let succeeded = status.success();
                    DonePayload {
                        attempt_id: id.clone(),
                        exit_code: code,
                        succeeded,
                        reason: if succeeded {
                            "build succeeded".to_string()
                        } else {
                            format!("build failed (exit code {:?})", code)
                        },
                    }
                }
                Ok(Some(Err(e))) => DonePayload {
                    attempt_id: id.clone(),
                    exit_code: None,
                    succeeded: false,
                    reason: format!("wait error: {}", e),
                },
                Ok(None) => DonePayload {
                    attempt_id: id.clone(),
                    exit_code: None,
                    succeeded: false,
                    reason: "run already removed".to_string(),
                },
                Err(_) => {
                    // timeout — child kill
                    let mut runs = state_arc.runs.lock().await;
                    if let Some(run) = runs.get_mut(&id) {
                        let _ = run.child.start_kill();
                    }
                    DonePayload {
                        attempt_id: id.clone(),
                        exit_code: None,
                        succeeded: false,
                        reason: format!("timeout after {}s — killed", timeout.as_secs()),
                    }
                }
            };
            let _ = app.emit(&format!("build:done:{}", id), payload);
            let _ = state_arc.runs.lock().await.remove(&id);
        });
    }

    state
        .runs
        .lock()
        .await
        .insert(attempt_id.clone(), BuildRun { child });
    Ok(attempt_id)
}

#[tauri::command]
pub async fn build_kill(
    state: State<'_, Arc<BuildState>>,
    attempt_id: String,
) -> Result<(), String> {
    let mut runs = state.runs.lock().await;
    if let Some(run) = runs.get_mut(&attempt_id) {
        let _ = run.child.start_kill();
    }
    Ok(())
}
