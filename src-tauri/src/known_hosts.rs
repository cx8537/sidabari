use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// 단순한 JSON 기반 known_hosts. OpenSSH known_hosts 호환은 future work.
// 1인용 도구라 우리 앱 전용 형식 충분. 위치: app_config_dir/known_hosts.json
// 권한: Unix는 0600, Windows는 ACL 별도 (CLAUDE.md §1.2.7).

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnownHosts {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub entries: HashMap<String, String>, // host:port → fingerprint(SHA256:...)
}

fn default_schema_version() -> u32 {
    1
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir resolve 실패: {}", e))?;
    Ok(dir.join("known_hosts.json"))
}

pub fn load(app: &AppHandle) -> Result<KnownHosts, String> {
    let path = known_hosts_path(app)?;
    if !path.exists() {
        return Ok(KnownHosts {
            schema_version: 1,
            entries: HashMap::new(),
        });
    }
    let bytes = fs::read(&path).map_err(|e| format!("known_hosts 읽기 실패: {}", e))?;
    let kh: KnownHosts =
        serde_json::from_slice(&bytes).map_err(|e| format!("known_hosts 파싱 실패: {}", e))?;
    Ok(kh)
}

pub fn save(app: &AppHandle, kh: &KnownHosts) -> Result<(), String> {
    let path = known_hosts_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("known_hosts 디렉토리 생성 실패: {}", e))?;
    }
    let json = serde_json::to_vec_pretty(kh)
        .map_err(|e| format!("known_hosts 직렬화 실패: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("known_hosts 쓰기 실패: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&path, perms);
    }
    Ok(())
}

pub fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}
