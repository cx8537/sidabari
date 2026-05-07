use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::audit_log::AuditDb;

// 사양서 §3 / CLAUDE.md §1.2 — Claude Code 훅으로부터 들어오는 시그널을 파일 기반 IPC로 받는다.
//
// 디렉토리 구조 (init에서 생성):
//   <app_data>/sidabari-hooks/
//     scripts/append-event.js  (일방향 — node가 events.jsonl에 append)
//     scripts/gate.js          (양방향 — req-/resp- 파일 페어)
//     events.jsonl             (append-only, 우리 watcher가 tail)
//     req-<uuid>.json          (gate 요청, 임시)
//     resp-<uuid>.json         (gate 응답, 임시)
//
// 보안:
//   - 디렉토리 권한 0700 (Unix). Windows는 사용자 ACL이 보호 (단일 사용자 PC 가정).
//   - resp 작성 권한이 곧 gate 결정 권한 — 다른 사용자 위장 불가.
//   - events.jsonl에는 PostToolUse의 tool_result 등 사용자 작업 데이터가 들어올 수 있어
//     영구 로그화는 별도 단계(Phase 5)에서 사용자가 명시 활성화.
//
// CLAUDE.md §1.3:
//   - watcher 실패 시 자동 재시도 X. stderr 로그 + emit으로 알림. 사용자 결정.

const HOOKS_SUBDIR: &str = "sidabari-hooks";
const SCRIPTS_SUBDIR: &str = "scripts";
const EVENTS_FILE: &str = "events.jsonl";
const APPEND_SCRIPT: &str = "append-event.js";
const GATE_SCRIPT: &str = "gate.js";

const APPEND_SCRIPT_BODY: &str = include_str!("../resources/append-event.js");
const GATE_SCRIPT_BODY: &str = include_str!("../resources/gate.js");

/// frontend가 hook 설치 시 settings.local.json에 박을 절대 경로들.
#[derive(Debug, Clone, Serialize)]
pub struct HookPaths {
    pub base_dir: String,
    pub append_script: String,
    pub gate_script: String,
}

pub struct HookBusState {
    pub paths: HookPaths,
    /// notify watcher는 drop되면 멈추므로 보관만 한다 (lock 필요 없음).
    _watcher: Mutex<RecommendedWatcher>,
}

#[derive(Debug, Serialize, Clone)]
struct HookEventEmit {
    /// "stop" | "pretool" | "posttool" | "notification" | "session-start" | "other:<name>"
    kind: String,
    payload: Value,
}

#[derive(Debug, Serialize, Clone)]
struct GateRequestEmit {
    request_id: String,
    panel_id: Option<String>,
    hook_event_name: String,
    payload: Value,
}

/// app setup에서 호출. 디렉토리 준비 + 스크립트 배포 + 잔여 sweep + watcher 시작.
pub fn init(app: &AppHandle) -> Result<HookBusState, String> {
    let base = base_dir(app)?;
    let scripts_dir = base.join(SCRIPTS_SUBDIR);
    fs::create_dir_all(&scripts_dir)
        .map_err(|e| format!("hooks 디렉토리 생성 실패 ({}): {}", scripts_dir.display(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&base, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&scripts_dir, fs::Permissions::from_mode(0o700));
    }

    // 스크립트는 매 init마다 덮어써 코드 갱신을 반영한다.
    let append_path = scripts_dir.join(APPEND_SCRIPT);
    let gate_path = scripts_dir.join(GATE_SCRIPT);
    fs::write(&append_path, APPEND_SCRIPT_BODY)
        .map_err(|e| format!("append-event.js 쓰기 실패: {}", e))?;
    fs::write(&gate_path, GATE_SCRIPT_BODY)
        .map_err(|e| format!("gate.js 쓰기 실패: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&append_path, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&gate_path, fs::Permissions::from_mode(0o700));
    }

    let events_path = base.join(EVENTS_FILE);
    if !events_path.exists() {
        fs::write(&events_path, b"")
            .map_err(|e| format!("events.jsonl 생성 실패: {}", e))?;
    }
    // 시작 시점의 파일 끝을 기준 offset으로 잡아 과거 이벤트는 무시한다.
    let start_offset = events_path.metadata().map(|m| m.len()).unwrap_or(0);

    sweep_stale(&base);

    let paths = HookPaths {
        base_dir: base.to_string_lossy().to_string(),
        append_script: append_path.to_string_lossy().to_string(),
        gate_script: gate_path.to_string_lossy().to_string(),
    };

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("watcher 생성 실패: {}", e))?;
    watcher
        .watch(&base, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watcher 등록 실패 ({}): {}", base.display(), e))?;

    {
        let app = app.clone();
        let base = base.clone();
        let events_path = events_path.clone();
        let mut offset = start_offset;
        thread::spawn(move || {
            for ev in rx {
                let event = match ev {
                    Ok(e) => e,
                    Err(e) => {
                        eprintln!("[hooks_bus] watch error: {}", e);
                        continue;
                    }
                };
                handle_event(&app, &base, &events_path, &mut offset, event);
            }
        });
    }

    Ok(HookBusState {
        paths,
        _watcher: Mutex::new(watcher),
    })
}

fn handle_event(
    app: &AppHandle,
    _base: &Path,
    events_path: &Path,
    offset: &mut u64,
    event: Event,
) {
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {}
        _ => return,
    }
    for path in &event.paths {
        if path == events_path {
            tail_events(app, events_path, offset);
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if file_name.starts_with("req-")
            && path.extension().and_then(|s| s.to_str()) == Some("json")
        {
            handle_req_file(app, path);
        }
    }
}

fn tail_events(app: &AppHandle, events_path: &Path, offset: &mut u64) {
    let mut file = match File::open(events_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[hooks_bus] events.jsonl open 실패: {}", e);
            return;
        }
    };
    let len = match file.metadata().map(|m| m.len()) {
        Ok(l) => l,
        Err(_) => return,
    };
    if len < *offset {
        // truncate/rotate 감지 — 처음부터 다시.
        *offset = 0;
    }
    if len == *offset {
        return;
    }
    if let Err(e) = file.seek(SeekFrom::Start(*offset)) {
        eprintln!("[hooks_bus] seek 실패: {}", e);
        return;
    }
    let reader = BufReader::new(file);
    let mut new_offset = *offset;
    for line_res in reader.lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[hooks_bus] readline 실패: {}", e);
                break;
            }
        };
        new_offset += line.len() as u64 + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let payload: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[hooks_bus] JSON 파싱 실패: {} (line {} bytes)", e, trimmed.len());
                continue;
            }
        };
        let kind = classify_event(&payload);

        // Phase 5a — 영구 적재. AuditDb가 setup 단계에서 manage되어 있어야 함.
        if let Some(audit) = app.try_state::<Arc<AuditDb>>() {
            let panel_id = payload
                .get("_sidabari")
                .and_then(|s| s.get("panel_id"))
                .and_then(|v| v.as_str());
            let hook_event_name = payload
                .get("hook_event_name")
                .and_then(|v| v.as_str());
            let tool_name = payload.get("tool_name").and_then(|v| v.as_str());
            crate::audit_log::insert(
                &audit,
                panel_id,
                &kind,
                hook_event_name,
                tool_name,
                trimmed,
            );
        }

        let _ = app.emit(
            "hook:event",
            &HookEventEmit {
                kind,
                payload,
            },
        );
    }
    *offset = new_offset;
}

fn classify_event(payload: &Value) -> String {
    let arg = payload
        .get("_sidabari")
        .and_then(|s| s.get("hook_event_name_arg"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let direct = payload
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let raw = arg.or(direct).unwrap_or_else(|| "unknown".to_string());
    match raw.as_str() {
        "Stop" => "stop".to_string(),
        "PreToolUse" => "pretool".to_string(),
        "PostToolUse" => "posttool".to_string(),
        "Notification" => "notification".to_string(),
        "SessionStart" => "session-start".to_string(),
        "SubagentStop" => "subagent-stop".to_string(),
        "UserPromptSubmit" => "user-prompt".to_string(),
        other => format!("other:{}", other),
    }
}

fn handle_req_file(app: &AppHandle, path: &Path) {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => {
            // Windows에서 atomic rename 직후 즉시 읽기가 잠깐 실패할 수 있음 — 짧은 재시도.
            thread::sleep(Duration::from_millis(50));
            match fs::read(path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[hooks_bus] req 읽기 실패 ({}): {}", path.display(), e);
                    return;
                }
            }
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[hooks_bus] req JSON 파싱 실패: {}", e);
            return;
        }
    };
    let request_id = value
        .get("request_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let panel_id = value
        .get("panel_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let hook_event_name = value
        .get("hook_event_name_arg")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let _ = app.emit(
        "hook:gate-request",
        &GateRequestEmit {
            request_id,
            panel_id,
            hook_event_name,
            payload: value,
        },
    );
}

fn sweep_stale(base: &Path) {
    let entries = match fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if (name_str.starts_with("req-") || name_str.starts_with("resp-"))
            && (name_str.ends_with(".json") || name_str.ends_with(".tmp"))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir resolve 실패: {}", e))?;
    Ok(dir.join(HOOKS_SUBDIR))
}

/// frontend가 게이트 요청에 응답할 때 호출. gate.js가 폴링 중인 resp-<id>.json을 atomic 작성.
#[tauri::command]
pub async fn hook_gate_respond(
    state: tauri::State<'_, Arc<HookBusState>>,
    request_id: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("request_id 비어있음".to_string());
    }
    let normalized = match decision.as_str() {
        "allow" | "deny" | "ask" | "defer" => decision.clone(),
        _ => return Err(format!("decision 값 부정확: {}", decision)),
    };
    let base = PathBuf::from(&state.paths.base_dir);
    let resp_path = base.join(format!("resp-{}.json", request_id));
    let tmp_path = base.join(format!("resp-{}.json.tmp", request_id));
    let body = serde_json::json!({
        "permissionDecision": normalized,
        "permissionDecisionReason": reason.unwrap_or_default(),
    });
    let bytes =
        serde_json::to_vec(&body).map_err(|e| format!("resp 직렬화 실패: {}", e))?;
    fs::write(&tmp_path, &bytes).map_err(|e| format!("resp tmp 쓰기 실패: {}", e))?;
    fs::rename(&tmp_path, &resp_path).map_err(|e| format!("resp rename 실패: {}", e))?;
    Ok(())
}

/// frontend가 hook 절대경로를 조회 (settings.local.json install 시 박기 위함).
#[tauri::command]
pub async fn hook_paths(
    state: tauri::State<'_, Arc<HookBusState>>,
) -> Result<HookPaths, String> {
    Ok(state.paths.clone())
}
