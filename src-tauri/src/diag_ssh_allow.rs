use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// 사양서 §3 / CLAUDE.md §1.2 — Claude Code의 두 게이트(permissions + autoMode classifier) 양쪽에 진단 SSH 자동 허용 등록.
//
// Claude Code 권한 시스템은 두 단계:
//   1) permissions (deny > ask > allow, first-match) — settings.local.json:permissions.allow
//   2) autoMode classifier (LLM 기반, auto mode일 때만) — settings.local.json:autoMode.allow (자연어 규칙)
//
// 메인 Claude가 [시스템 데이터 수집]을 실행할 때 두 단계 모두 통과해야 자동 실행됨.
// auto mode classifier는 ssh를 "Production Read via remote shell"로 분류해 차단 가능 — 자연어 예외 명시 필요.
// 공식 문서: https://code.claude.com/docs/en/auto-mode-config.md
//
// 등록 위치:
//   permissions.allow ← `Bash(ssh -i * <user>@<host> *)` 패턴
//   autoMode.allow    ← 자연어 자기 설명 (LLM이 의도 이해)
//
// 안전성:
//   - permissions 패턴은 host와 user를 정확 매칭 → 다른 호스트에 영향 없음
//   - autoMode entry는 ForceCommand 잠금을 명시 → classifier가 위험 감수 인지
//   - ForceCommand로 잠긴 진단 키 사용을 가정 → 두 게이트 통과해도 시스템 변경 불가
//   - 패턴 인젝션 방지: host/user에 와일드카드·괄호·공백·세미콜론·백슬래시 거부
//
// 마커: permissions._sidabari_managed_diag_ssh_allow — 자기 관리 영역 식별.
// 마커 안에 pattern과 automode_entry 두 텍스트 보관 → 호스트 변경 시 두 영역 모두 정확히 갱신.

const ALLOW_MARKER_KEY: &str = "_sidabari_managed_diag_ssh_allow";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagAllowReport {
    pub installed_path: String,
    pub created: bool,
    pub backed_up_path: Option<String>,
    /// 등록된 모든 ssh 패턴 (인자 없음 + 인자 있음).
    pub patterns: Vec<String>,
    pub automode_entry: String,
    pub removed_count: usize,
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

fn validate_host_user(host: &str, user: &str) -> Result<(), String> {
    let h = host.trim();
    let u = user.trim();
    if h.is_empty() {
        return Err("EC2 host가 비어있음".to_string());
    }
    if u.is_empty() {
        return Err("EC2 user가 비어있음".to_string());
    }
    let bad = |c: char| {
        c == '*'
            || c == '('
            || c == ')'
            || c == ';'
            || c == '\\'
            || c == '"'
            || c == '\''
            || c.is_whitespace()
    };
    if h.chars().any(bad) || u.chars().any(bad) {
        return Err("host/user에 공백·괄호·*·;·따옴표 등 메타 문자는 허용되지 않습니다".to_string());
    }
    Ok(())
}

/// Sidabari가 생성하는 ssh 명령 패턴 (둘 모두 등록):
///   1) 인자 없음: ssh -i "<key>" -p <port> -o ... <user>@<host>           ← MainClaudePanel 현재 형태
///   2) 인자 있음: ssh -i "<key>" -p <port> -o ... <user>@<host> '<cmd>'   ← 향후 변형 호환
/// 공식 문서: `*`는 공백/따옴표 포함 모든 문자 매칭. 패턴 끝의 " *"는 트레일링 인자를 요구하므로
/// 인자 없는 명령은 별도 패턴이 필요.
fn build_patterns(host: &str, user: &str) -> Vec<String> {
    vec![
        format!("Bash(ssh -i * {}@{})", user, host),
        format!("Bash(ssh -i * {}@{} *)", user, host),
    ]
}

/// auto mode classifier(LLM)에게 보여줄 자연어 자기 설명.
/// classifier는 prose 규칙을 LLM으로 평가하므로 "왜 안전한가"를 명확히 풀어 쓴다.
/// 공식 문서 권장: 자연어로 작성. https://code.claude.com/docs/en/auto-mode-config.md
fn build_automode_entry(host: &str, user: &str) -> String {
    format!(
        "SSH connection from this Sidabari-managed Claude session to {user}@{host} \
        is explicitly allowed for read-only diagnostic data collection. The Sidabari-generated \
        SSH command passes NO shell command argument to the server — only the connection itself. \
        The remote host's sshd is configured with a ForceCommand directive that intercepts this \
        specific diagnostic SSH key and executes /usr/local/bin/sidabari-collect on the server \
        side, regardless of any command the client might send. This means: no interactive shell, \
        no port forwarding, no scp/sftp, no system modification is possible — enforced by sshd \
        configuration, not by client-side trust. Even if Claude were to attempt sending arbitrary \
        commands, the server would still execute only sidabari-collect and disconnect. Sidabari \
        (the desktop tool managing this Claude Code session) registered this allowance after the \
        user explicitly clicked the [진단 SSH 자동 허용 등록] button in the Sidabari settings UI; \
        the host-side ForceCommand setup is documented at docs/ec2-diag-setup/README.md. Treat \
        this specific {user}@{host} SSH connection as trusted read-only production diagnostics \
        — not as an arbitrary remote shell."
    )
}

fn write_with_backup(path: &Path, content: &[u8]) -> Result<Option<String>, String> {
    let backup = if path.exists() {
        let bak = path.with_extension("local.json.sidabari-diagssh-bak");
        fs::copy(path, &bak).map_err(|e| format!("백업 실패: {}", e))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    fs::write(path, content).map_err(|e| format!("쓰기 실패: {}", e))?;
    Ok(backup)
}

fn read_settings(path: &Path) -> Result<(Map<String, Value>, bool), String> {
    if !path.exists() {
        return Ok((Map::new(), true));
    }
    let bytes = fs::read(path).map_err(|e| format!("기존 설정 읽기 실패: {}", e))?;
    if bytes.is_empty() {
        return Ok((Map::new(), false));
    }
    let parsed: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("기존 설정 JSON 파싱 실패: {}", e))?;
    let map = match parsed {
        Value::Object(m) => m,
        _ => return Err("settings.local.json이 객체가 아닙니다".to_string()),
    };
    Ok((map, false))
}

#[tauri::command]
pub async fn install_diag_ssh_allow(
    directory: String,
    host: String,
    user: String,
) -> Result<DiagAllowReport, String> {
    validate_host_user(&host, &user)?;
    let work_dir = validate_dir(&directory)?;
    let claude_dir = work_dir.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!(".claude 생성 실패: {}", e))?;
    let settings_path = claude_dir.join("settings.local.json");

    let (mut root, created) = read_settings(&settings_path)?;
    let patterns = build_patterns(&host, &user);
    let automode_entry = build_automode_entry(&host, &user);
    let mut removed = 0usize;

    // 이전 마커의 모든 패턴 후보(단수/복수, 구버전 호환) 회수.
    let mut prev_patterns: Vec<String> = Vec::new();
    if let Some(prev_marker) = root
        .get("permissions")
        .and_then(|v| v.get(ALLOW_MARKER_KEY))
    {
        if let Some(arr) = prev_marker.get("patterns").and_then(|v| v.as_array()) {
            for p in arr {
                if let Some(s) = p.as_str() {
                    prev_patterns.push(s.to_string());
                }
            }
        }
        if let Some(s) = prev_marker.get("pattern").and_then(|v| v.as_str()) {
            prev_patterns.push(s.to_string());
        }
    }
    let prev_automode = root
        .get("permissions")
        .and_then(|v| v.get(ALLOW_MARKER_KEY))
        .and_then(|m| m.get("automode_entry"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // ============ 1) permissions.allow 갱신 ============
    {
        let permissions = root
            .entry("permissions".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let perm_obj = match permissions {
            Value::Object(m) => m,
            _ => {
                *permissions = Value::Object(Map::new());
                permissions.as_object_mut().unwrap()
            }
        };

        // 이전 _sidabari 패턴(단수/복수) 모두 제거 — 호스트 변경/패턴 형식 변경 대응.
        if !prev_patterns.is_empty() {
            if let Some(Value::Array(arr)) = perm_obj.get_mut("allow") {
                let before = arr.len();
                arr.retain(|v| {
                    v.as_str()
                        .map(|s| !prev_patterns.iter().any(|p| p == s))
                        .unwrap_or(true)
                });
                removed += before - arr.len();
            }
        }

        let allow_value = perm_obj
            .entry("allow".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let allow_arr = match allow_value {
            Value::Array(a) => a,
            _ => {
                *allow_value = Value::Array(Vec::new());
                allow_value.as_array_mut().unwrap()
            }
        };
        for pattern in &patterns {
            if !allow_arr
                .iter()
                .any(|v| v.as_str() == Some(pattern.as_str()))
            {
                allow_arr.push(Value::String(pattern.clone()));
            }
        }

        perm_obj.insert(
            ALLOW_MARKER_KEY.to_string(),
            json!({
                "version": 3,
                "host": host,
                "user": user,
                "patterns": patterns,
                "automode_entry": automode_entry,
                "note": "Sidabari 자동 등록 — 진단 SSH 호스트 바운드 자동 허용 (permissions.allow 두 형태 + autoMode.allow). ForceCommand 셋업이 완료된 호스트에서만 사용.",
            }),
        );
    }

    // ============ 2) autoMode.allow 갱신 ============
    // 공식 문서 (auto-mode-config.md):
    //   - "$defaults" 포함해야 기본 차단 규칙(force push, exfiltration 등) 보존
    //   - 새 키 생성 시에만 우리가 "$defaults" 포함시켜 사용자 설정을 깨지 않게 함
    //   - 기존 autoMode.allow가 있으면 그대로 두고 우리 entry만 추가/갱신
    {
        let automode = root
            .entry("autoMode".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let automode_obj = match automode {
            Value::Object(m) => m,
            _ => {
                *automode = Value::Object(Map::new());
                automode.as_object_mut().unwrap()
            }
        };

        let allow_existed = automode_obj.contains_key("allow");
        let allow_value = automode_obj.entry("allow".to_string()).or_insert_with(|| {
            // 신규 생성 시 "$defaults" 포함 — 기본 차단 규칙 보존.
            Value::Array(vec![Value::String("$defaults".to_string())])
        });
        let allow_arr = match allow_value {
            Value::Array(a) => a,
            _ => {
                *allow_value = Value::Array(Vec::new());
                allow_value.as_array_mut().unwrap()
            }
        };
        let _ = allow_existed; // (사용하지 않지만 의미 있는 분기 명시)

        // 호스트 변경 시 이전 자연어 entry 제거.
        if let Some(prev_am) = &prev_automode {
            if prev_am != &automode_entry {
                let before = allow_arr.len();
                allow_arr.retain(|v| v.as_str() != Some(prev_am.as_str()));
                removed += before - allow_arr.len();
            }
        }

        if !allow_arr
            .iter()
            .any(|v| v.as_str() == Some(automode_entry.as_str()))
        {
            allow_arr.push(Value::String(automode_entry.clone()));
        }
    }

    let serialized = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON 직렬화 실패: {}", e))?;
    let backup = write_with_backup(&settings_path, &serialized)?;

    Ok(DiagAllowReport {
        installed_path: settings_path.to_string_lossy().to_string(),
        created,
        backed_up_path: backup,
        patterns,
        automode_entry,
        removed_count: removed,
    })
}

#[tauri::command]
pub async fn remove_diag_ssh_allow(directory: String) -> Result<DiagAllowReport, String> {
    let work_dir = validate_dir(&directory)?;
    let settings_path = work_dir.join(".claude").join("settings.local.json");
    if !settings_path.exists() {
        return Ok(DiagAllowReport {
            installed_path: settings_path.to_string_lossy().to_string(),
            created: false,
            backed_up_path: None,
            patterns: Vec::new(),
            automode_entry: String::new(),
            removed_count: 0,
        });
    }
    let (mut root, _) = read_settings(&settings_path)?;
    let mut removed = 0usize;
    let mut removed_patterns: Vec<String> = Vec::new();
    let mut automode_entry = String::new();

    // 마커 미리 읽고 두 영역(permissions.allow + autoMode.allow) 정리.
    if let Some(Value::Object(perm)) = root.get_mut("permissions") {
        if let Some(prev_marker) = perm.remove(ALLOW_MARKER_KEY) {
            // 단수/복수 둘 다 회수
            if let Some(arr) = prev_marker.get("patterns").and_then(|v| v.as_array()) {
                for p in arr {
                    if let Some(s) = p.as_str() {
                        removed_patterns.push(s.to_string());
                    }
                }
            }
            if let Some(s) = prev_marker.get("pattern").and_then(|v| v.as_str()) {
                removed_patterns.push(s.to_string());
            }
            if !removed_patterns.is_empty() {
                if let Some(Value::Array(arr)) = perm.get_mut("allow") {
                    let before = arr.len();
                    arr.retain(|v| {
                        v.as_str()
                            .map(|s| !removed_patterns.iter().any(|p| p == s))
                            .unwrap_or(true)
                    });
                    removed += before - arr.len();
                }
            }
            if let Some(prev_am) = prev_marker
                .get("automode_entry")
                .and_then(|v| v.as_str())
            {
                automode_entry = prev_am.to_string();
            }
        }
    }
    if !automode_entry.is_empty() {
        if let Some(Value::Object(am)) = root.get_mut("autoMode") {
            if let Some(Value::Array(arr)) = am.get_mut("allow") {
                let before = arr.len();
                arr.retain(|v| v.as_str() != Some(automode_entry.as_str()));
                removed += before - arr.len();
            }
        }
    }

    let serialized = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON 직렬화 실패: {}", e))?;
    let backup = write_with_backup(&settings_path, &serialized)?;
    Ok(DiagAllowReport {
        installed_path: settings_path.to_string_lossy().to_string(),
        created: false,
        backed_up_path: backup,
        patterns: removed_patterns,
        automode_entry,
        removed_count: removed,
    })
}

#[tauri::command]
pub async fn diag_ssh_allow_status(
    directory: String,
) -> Result<Option<DiagAllowReport>, String> {
    let work_dir = validate_dir(&directory)?;
    let path = work_dir.join(".claude").join("settings.local.json");
    if !path.exists() {
        return Ok(None);
    }
    let (root, _) = read_settings(&path)?;
    let marker = root
        .get("permissions")
        .and_then(|p| p.as_object())
        .and_then(|p| p.get(ALLOW_MARKER_KEY));
    if let Some(m) = marker {
        let mut patterns: Vec<String> = Vec::new();
        if let Some(arr) = m.get("patterns").and_then(|v| v.as_array()) {
            for p in arr {
                if let Some(s) = p.as_str() {
                    patterns.push(s.to_string());
                }
            }
        }
        if let Some(s) = m.get("pattern").and_then(|v| v.as_str()) {
            patterns.push(s.to_string());
        }
        let automode_entry = m
            .get("automode_entry")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(Some(DiagAllowReport {
            installed_path: path.to_string_lossy().to_string(),
            created: false,
            backed_up_path: None,
            patterns,
            automode_entry,
            removed_count: 0,
        }));
    }
    Ok(None)
}
