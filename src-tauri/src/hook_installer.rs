use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::State;

use crate::hooks_bus::HookBusState;

// 사양서 §3 / CLAUDE.md §1.2 — Claude Code 훅을 .claude/settings.local.json에 등록한다.
// claude_safety.rs와 동일 패턴: 기존 설정과 병합, 마커로 자기 관리 영역 식별, 백업 후 쓰기.

const HOOKS_MARKER_KEY: &str = "_sidabari_managed_hooks";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInstallReport {
    pub installed_path: String,
    pub created: bool,
    pub backed_up_path: Option<String>,
    pub events_added: Vec<String>,
}

fn validate_dir(directory: &str) -> Result<PathBuf, String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Err("작업 디렉토리가 설정되지 않았습니다".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("작업 디렉토리는 절대경로여야 합니다".to_string());
    }
    if !path.exists() {
        return Err(format!("작업 디렉토리가 존재하지 않습니다: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("작업 디렉토리가 폴더가 아닙니다: {}", path.display()));
    }
    Ok(path)
}

/// 경로에 공백/특수문자가 있을 수 있어 큰따옴표로 감싸고 내부 따옴표 escape.
fn shell_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// (event_name, matcher, command) 목록.
/// enable_gate=true면 PreToolUse(matcher="Bash")가 추가로 gate.js로 라우팅된다.
/// 기본 PreToolUse(matcher="")는 항상 append (모든 도구 호출 기록).
fn build_hook_specs(
    append_script: &Path,
    gate_script: &Path,
    enable_gate: bool,
) -> Vec<(&'static str, &'static str, String)> {
    let aq = shell_quote(&append_script.to_string_lossy());
    let gq = shell_quote(&gate_script.to_string_lossy());
    let mk_append = |event: &str| format!("node {} {}", aq, event);
    let mk_gate = |event: &str| format!("node {} {}", gq, event);
    let mut specs: Vec<(&'static str, &'static str, String)> = vec![
        ("Stop", "", mk_append("Stop")),
        ("SessionStart", "", mk_append("SessionStart")),
        ("Notification", "", mk_append("Notification")),
        ("PreToolUse", "", mk_append("PreToolUse")),
        ("PostToolUse", "", mk_append("PostToolUse")),
    ];
    if enable_gate {
        // matcher="Bash" — Bash 도구 호출만 모달 차단. 다른 PreToolUse는 위 append만 발사.
        specs.push(("PreToolUse", "Bash", mk_gate("PreToolUse")));
    }
    specs
}

/// Sidabari가 관리하는 영역(_sidabari=true) 만 제거 + 새 spec 일괄 추가.
/// 이렇게 하면 사용자가 [위험 도구 차단] 토글을 끄고 다시 [훅 설치]를 누르면 gate가 자동 제거된다.
fn merge_hooks(
    existing: &mut Map<String, Value>,
    specs: &[(&'static str, &'static str, String)],
) -> Vec<String> {
    let hooks_value = existing
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks_obj = match hooks_value {
        Value::Object(m) => m,
        _ => {
            *hooks_value = Value::Object(Map::new());
            hooks_value.as_object_mut().unwrap()
        }
    };

    // 1) 기존 _sidabari 그룹 제거.
    for (_event, val) in hooks_obj.iter_mut() {
        if let Value::Array(arr) = val {
            arr.retain(|group| {
                let hooks = group.get("hooks").and_then(|h| h.as_array());
                let all_sidabari = hooks
                    .map(|hs| {
                        !hs.is_empty()
                            && hs.iter().all(|h| {
                                h.get("_sidabari")
                                    .and_then(|s| s.as_bool())
                                    .unwrap_or(false)
                            })
                    })
                    .unwrap_or(false);
                !all_sidabari
            });
        }
    }
    // 빈 array 정리 — 사용자 설정에 빈 키가 남지 않도록.
    hooks_obj.retain(|_, v| !matches!(v, Value::Array(a) if a.is_empty()));

    // 2) 새 spec 추가.
    let mut added = Vec::new();
    for (event, matcher, command) in specs {
        let event_value = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let event_arr = match event_value {
            Value::Array(a) => a,
            _ => {
                *event_value = Value::Array(Vec::new());
                event_value.as_array_mut().unwrap()
            }
        };

        let group = json!({
            "matcher": matcher,
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "_sidabari": true
                }
            ]
        });
        event_arr.push(group);
        added.push((*event).to_string());
    }

    existing.insert(
        HOOKS_MARKER_KEY.to_string(),
        json!({
            "version": 1,
            "note": "Sidabari 자동 설치. 갱신은 설정 모달 → [훅 설치] 다시 클릭.",
        }),
    );

    added
}

fn write_with_backup(path: &Path, content: &[u8]) -> Result<Option<String>, String> {
    let backup = if path.exists() {
        let bak = path.with_extension("local.json.sidabari-hooks-bak");
        fs::copy(path, &bak).map_err(|e| format!("백업 실패: {}", e))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    fs::write(path, content).map_err(|e| format!("쓰기 실패: {}", e))?;
    Ok(backup)
}

#[tauri::command]
pub async fn install_claude_hooks(
    state: State<'_, Arc<HookBusState>>,
    directory: String,
    enable_gate: bool,
) -> Result<HookInstallReport, String> {
    let work_dir = validate_dir(&directory)?;
    let claude_dir = work_dir.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!(".claude 생성 실패: {}", e))?;
    let settings_path = claude_dir.join("settings.local.json");

    let (mut root, created) = if settings_path.exists() {
        let bytes = fs::read(&settings_path)
            .map_err(|e| format!("기존 설정 읽기 실패: {}", e))?;
        let parsed: Value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|e| format!("기존 설정 JSON 파싱 실패: {}", e))?
        };
        let map = match parsed {
            Value::Object(m) => m,
            _ => return Err("settings.local.json이 객체가 아닙니다".to_string()),
        };
        (map, false)
    } else {
        (Map::new(), true)
    };

    let append_path = PathBuf::from(&state.paths.append_script);
    let gate_path = PathBuf::from(&state.paths.gate_script);
    let specs = build_hook_specs(&append_path, &gate_path, enable_gate);
    let added = merge_hooks(&mut root, &specs);

    let serialized = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON 직렬화 실패: {}", e))?;
    let backup = write_with_backup(&settings_path, &serialized)?;

    Ok(HookInstallReport {
        installed_path: settings_path.to_string_lossy().to_string(),
        created,
        backed_up_path: backup,
        events_added: added,
    })
}

#[tauri::command]
pub async fn claude_hooks_status(directory: String) -> Result<Option<HookInstallReport>, String> {
    let work_dir = validate_dir(&directory)?;
    let path = work_dir.join(".claude").join("settings.local.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("설정 읽기 실패: {}", e))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let parsed: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("JSON 파싱 실패: {}", e))?;
    let managed = parsed.get(HOOKS_MARKER_KEY).is_some();
    if !managed {
        return Ok(None);
    }
    let mut events = Vec::new();
    if let Some(hooks_obj) = parsed.get("hooks").and_then(|v| v.as_object()) {
        for (k, v) in hooks_obj {
            if let Some(arr) = v.as_array() {
                let any = arr.iter().any(|group| {
                    group
                        .get("hooks")
                        .and_then(|h| h.as_array())
                        .map(|hooks| {
                            hooks.iter().any(|h| {
                                h.get("_sidabari")
                                    .and_then(|s| s.as_bool())
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                });
                if any {
                    events.push(k.clone());
                }
            }
        }
    }
    Ok(Some(HookInstallReport {
        installed_path: path.to_string_lossy().to_string(),
        created: false,
        backed_up_path: None,
        events_added: events,
    }))
}
