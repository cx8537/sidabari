use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// 사양서 §3.6 / CLAUDE.md §1.3 — Claude Code 권한 deny 규칙 설치.
// 메인 Claude 작업 디렉토리(설정의 claude_code_sessions.main.directory)의
// .claude/settings.local.json에 위험 명령(rm/systemctl stop/scp 등) deny 규칙을 추가한다.
// 기존 설정과 병합 — Claude Code가 이미 쓰던 다른 규칙을 보존.
//
// 보조 방어선: 핵심은 EC2 ForceCommand. 로컬 deny는 ssh가 아닌 다른 변형 시도(scp/sftp/curl 등)
// 를 추가 차단한다. 패턴 매칭이라 우회 가능 — 단독 의존 금지.

const RULES_MARKER_KEY: &str = "_sidabari_managed";

// 위험 명령 deny 패턴. Claude Code의 글랍 패턴 형식.
// "당장은 정보만 수집"(사용자 요청)이 목표라 SSH 외 모든 시스템 변경 변형을 차단.
fn deny_patterns() -> Vec<&'static str> {
    vec![
        // 파일 삭제/이동/덮어쓰기 (로컬·원격 양쪽)
        "Bash(rm:*)",
        "Bash(*rm -rf*)",
        "Bash(*rm -fr*)",
        "Bash(sudo rm:*)",
        "Bash(*sudo rm*)",
        "Bash(mv:*)",
        "Bash(*sudo mv*)",
        "Bash(*sudo cp*)",
        "Bash(*sudo dd*)",
        "Bash(dd:*)",
        "Bash(*mkfs*)",
        "Bash(*shred*)",
        // 권한 변경
        "Bash(chmod:*)",
        "Bash(chown:*)",
        "Bash(*sudo chmod*)",
        "Bash(*sudo chown*)",
        // 서비스 변경
        "Bash(*systemctl stop*)",
        "Bash(*systemctl start*)",
        "Bash(*systemctl restart*)",
        "Bash(*systemctl reload*)",
        "Bash(*systemctl disable*)",
        "Bash(*systemctl enable*)",
        "Bash(*systemctl mask*)",
        "Bash(*systemctl unmask*)",
        "Bash(*service * stop*)",
        "Bash(*service * restart*)",
        "Bash(*service * start*)",
        "Bash(*kill -9*)",
        "Bash(*killall*)",
        "Bash(*pkill*)",
        // 패키지 변경
        "Bash(*apt install*)",
        "Bash(*apt remove*)",
        "Bash(*apt-get install*)",
        "Bash(*apt-get remove*)",
        "Bash(*yum install*)",
        "Bash(*yum remove*)",
        "Bash(*dnf install*)",
        "Bash(*dnf remove*)",
        "Bash(*pip install*)",
        "Bash(*pip3 install*)",
        "Bash(*npm install*)",
        // 파일 업로드/원격 쓰기 (진단은 read-only)
        "Bash(scp:*)",
        "Bash(*scp *)",
        "Bash(sftp:*)",
        "Bash(*sftp *)",
        "Bash(rsync:*)",
        "Bash(*rsync *)",
        // 리다이렉션을 통한 파일 쓰기 (시스템/홈 경로)
        "Bash(*> /etc/*)",
        "Bash(*>> /etc/*)",
        "Bash(*> /var/*)",
        "Bash(*>> /var/*)",
        "Bash(*> /usr/*)",
        "Bash(*>> /usr/*)",
        "Bash(*> /home/*)",
        "Bash(*>> /home/*)",
        "Bash(*> /root/*)",
        "Bash(*>> /root/*)",
        // sudoers 변경
        "Bash(*visudo*)",
        // 네트워크 변경
        "Bash(*iptables*)",
        "Bash(*ufw *)",
        "Bash(*firewall-cmd*)",
        // 디렉토리 트리 통째 삭제 가능성
        "Bash(*rm -r*)",
        // curl/wget 후 실행 패턴
        "Bash(*curl* | bash*)",
        "Bash(*curl* | sh*)",
        "Bash(*wget* | bash*)",
        "Bash(*wget* | sh*)",
        // base64 디코딩 후 실행
        "Bash(*base64 -d* | bash*)",
        "Bash(*base64 -d* | sh*)",
        "Bash(*base64 --decode* | bash*)",
        // .claude/settings 자체 변조 차단 (Sidabari가 관리)
        "Edit(**/.claude/settings*)",
        "Write(**/.claude/settings*)",
        // NOTE: 이전 버전에 `Bash(*sidabari*)`가 있었음 — 너무 broad해 진단 SSH 명령
        // (키 경로에 sidabari-diag 포함)까지 차단해 [시스템 데이터 수집] 자체를 막았음.
        // 핵심 방어선은 EC2 ForceCommand 잠금이라 이 보조선 한 줄 빠져도 위험 미미.
        // [안전 규칙 설치]를 다시 클릭하면 self-cleanup으로 기존 라인이 자동 제거된다.
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallReport {
    pub installed_path: String,
    pub created: bool,
    pub backed_up_path: Option<String>,
    pub deny_count: usize,
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

fn merge_deny(existing: &mut Map<String, Value>, new_patterns: &[&str]) -> usize {
    // self-cleanup 패턴 — marker.installed_patterns에 이전에 설치한 패턴 목록을 보관해
    // [안전 규칙 설치] 재클릭 시 기존 _sidabari deny를 모두 제거 후 새 셋으로 갱신.
    // 이렇게 하면 deny 패턴이 코드에서 변경되어도 사용자가 한 번 더 클릭하면 동기화된다.
    let permissions = existing
        .entry("permissions".to_string())
        .or_insert_with(|| Value::Object(Map::new()));

    let perm_obj = match permissions {
        Value::Object(m) => m,
        _ => {
            *permissions = Value::Object(Map::new());
            permissions.as_object_mut().unwrap()
        }
    };

    // 이전 marker의 installed_patterns 회수.
    let prev_installed: Vec<String> = perm_obj
        .get(RULES_MARKER_KEY)
        .and_then(|m| m.get("installed_patterns"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let deny_arr = perm_obj
        .entry("deny".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let arr = match deny_arr {
        Value::Array(a) => a,
        _ => {
            *deny_arr = Value::Array(Vec::new());
            deny_arr.as_array_mut().unwrap()
        }
    };

    // 1) 이전 _sidabari 패턴 제거.
    if !prev_installed.is_empty() {
        arr.retain(|v| {
            v.as_str()
                .map(|s| !prev_installed.iter().any(|p| p == s))
                .unwrap_or(true)
        });
    }

    // 1b) 마이그레이션 — version 1 marker에서 넘어온 사용자는 marker.installed_patterns가 없어
    //     이전 코드가 등록했던 패턴을 식별 못 한다. 그래서 코드 변경으로 사라진 legacy 패턴은
    //     명시적으로 매 install 마다 제거 시도 (이미 없으면 무동작).
    //
    //     `Bash(*sidabari*)`: 진단 SSH 명령(키 경로의 sidabari-diag 단어)에 매칭되어 [시스템
    //     데이터 수집]을 차단하는 부작용 때문에 제거. 보호 가치 < 부작용.
    const LEGACY_REMOVED: &[&str] = &["Bash(*sidabari*)"];
    arr.retain(|v| {
        v.as_str()
            .map(|s| !LEGACY_REMOVED.contains(&s))
            .unwrap_or(true)
    });

    // 2) 새 패턴 추가 (이미 사용자가 별도로 같은 deny를 갖고 있으면 중복 방지).
    let mut existing_set: std::collections::HashSet<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    let mut added = 0;
    for pat in new_patterns {
        if existing_set.insert(pat.to_string()) {
            arr.push(Value::String(pat.to_string()));
            added += 1;
        }
    }

    // 3) marker 갱신 — installed_patterns에 우리가 설치한 셋 보관.
    let installed_list: Vec<Value> = new_patterns
        .iter()
        .map(|p| Value::String((*p).to_string()))
        .collect();
    perm_obj.insert(
        RULES_MARKER_KEY.to_string(),
        json!({
            "version": 2,
            "note": "Sidabari 자동 설치. docs/ec2-diag-setup/README.md 참조.",
            "installed_patterns": installed_list,
        }),
    );

    added
}

fn write_with_backup(path: &Path, content: &[u8]) -> Result<Option<String>, String> {
    let backup = if path.exists() {
        let bak = path.with_extension("local.json.sidabari-bak");
        fs::copy(path, &bak).map_err(|e| format!("백업 실패: {}", e))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    fs::write(path, content).map_err(|e| format!("쓰기 실패: {}", e))?;
    Ok(backup)
}

#[tauri::command]
pub async fn install_claude_safety_rules(directory: String) -> Result<InstallReport, String> {
    let work_dir = validate_dir(&directory)?;
    let claude_dir = work_dir.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!(".claude 디렉토리 생성 실패: {}", e))?;
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

    let patterns = deny_patterns();
    let added = merge_deny(&mut root, &patterns);

    let serialized = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON 직렬화 실패: {}", e))?;
    let backup = write_with_backup(&settings_path, &serialized)?;

    Ok(InstallReport {
        installed_path: settings_path.to_string_lossy().to_string(),
        created,
        backed_up_path: backup,
        deny_count: if created { patterns.len() } else { added },
    })
}

#[tauri::command]
pub async fn claude_safety_rules_status(directory: String) -> Result<Option<InstallReport>, String> {
    let work_dir = validate_dir(&directory)?;
    let path = work_dir.join(".claude").join("settings.local.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("설정 읽기 실패: {}", e))?;
    let parsed: Value = if bytes.is_empty() {
        return Ok(None);
    } else {
        serde_json::from_slice(&bytes).map_err(|e| format!("JSON 파싱 실패: {}", e))?
    };

    let deny_count = parsed
        .get("permissions")
        .and_then(|p| p.get("deny"))
        .and_then(|d| d.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let managed = parsed
        .get("permissions")
        .and_then(|p| p.get(RULES_MARKER_KEY))
        .is_some();
    if !managed && deny_count == 0 {
        return Ok(None);
    }

    Ok(Some(InstallReport {
        installed_path: path.to_string_lossy().to_string(),
        created: false,
        backed_up_path: None,
        deny_count,
    }))
}
