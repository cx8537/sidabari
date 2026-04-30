use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// 사양서 §5.2 스키마. 모든 필드 #[serde(default)] — 부분 파일도 관용적으로 로드.
// pem 파일 내용은 절대 저장하지 않음 (CLAUDE.md §1.2.1) — private_key_path는 경로 문자열만.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Project {
    pub name: String,
}

impl Default for Project {
    fn default() -> Self {
        Self { name: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeCodeSession {
    pub label: String,
    pub directory: String,
    pub auto_start: bool,
}

impl Default for ClaudeCodeSession {
    fn default() -> Self {
        Self {
            label: String::new(),
            directory: String::new(),
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeCodeSessions {
    pub main: ClaudeCodeSession,
    pub additional: Vec<ClaudeCodeSession>,
}

impl Default for ClaudeCodeSessions {
    fn default() -> Self {
        Self {
            main: ClaudeCodeSession::default(),
            additional: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Ec2Config {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub private_key_path: String,
    // 진단 전용 키. 서버 측 ForceCommand로 잠긴 키를 사용해 Claude가 SSH로 직접 접근할 때
    // 시스템 변경이 물리적으로 불가능하도록 분리된 키. 미설정 시 [시스템 데이터 수집] 비활성.
    // 자세한 셋업: docs/ec2-diag-setup/README.md
    pub diag_private_key_path: String,
}

impl Default for Ec2Config {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            user: "ubuntu".to_string(),
            private_key_path: String::new(),
            diag_private_key_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SftpConfig {
    pub use_same_as_ssh: bool,
    pub remote_upload_path: String,
}

impl Default for SftpConfig {
    fn default() -> Self {
        Self {
            use_same_as_ssh: true,
            remote_upload_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DeployConfig {
    pub build_command: String,
    pub build_working_directory: String,
    pub jar_output_path: String,
    pub build_timeout_seconds: u32,
    pub deploy_script: String,
    pub restart_script: String,
    pub stop_script: String,
}

impl Default for DeployConfig {
    fn default() -> Self {
        Self {
            build_command: String::new(),
            build_working_directory: String::new(),
            jar_output_path: String::new(),
            build_timeout_seconds: 300,
            deploy_script: String::new(),
            restart_script: String::new(),
            stop_script: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitoringConfig {
    pub log_command: String,
    pub error_pattern: String,
    pub context_lines_before: u32,
    pub context_lines_after: u32,
    pub context_capture_delay_seconds: u32,
}

impl Default for MonitoringConfig {
    fn default() -> Self {
        Self {
            log_command: String::new(),
            error_pattern: r"\[ERROR\]".to_string(),
            context_lines_before: 30,
            context_lines_after: 10,
            context_capture_delay_seconds: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SafetyConfig {
    pub ssh_disconnect_grace_seconds: u32,
}

impl Default for SafetyConfig {
    fn default() -> Self {
        Self { ssh_disconnect_grace_seconds: 10 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub schema_version: u32,
    pub display_name: String,
    pub project: Project,
    pub claude_code_sessions: ClaudeCodeSessions,
    pub ec2: Ec2Config,
    pub sftp: SftpConfig,
    pub deploy: DeployConfig,
    pub monitoring: MonitoringConfig,
    pub safety: SafetyConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 1,
            display_name: "또돌이".to_string(),
            project: Project::default(),
            claude_code_sessions: ClaudeCodeSessions::default(),
            ec2: Ec2Config::default(),
            sftp: SftpConfig::default(),
            deploy: DeployConfig::default(),
            monitoring: MonitoringConfig::default(),
            safety: SafetyConfig::default(),
        }
    }
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir resolve 실패: {}", e))?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub async fn load_config(app: tauri::AppHandle) -> Result<Config, String> {
    let path = config_file_path(&app)?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("config 읽기 실패: {}", e))?;
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|e| format!("config JSON 파싱 실패: {}", e))?;
    Ok(config)
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    if config.schema_version == 0 {
        return Err("schema_version 누락".to_string());
    }
    let path = config_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("config 디렉토리 생성 실패: {}", e))?;
    }
    let json =
        serde_json::to_vec_pretty(&config).map_err(|e| format!("config 직렬화 실패: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("config 쓰기 실패: {}", e))?;

    // CLAUDE.md §1.2.7 — 로그/설정 파일 권한 제한 (Unix만; Windows는 ACL 별도)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms)
            .map_err(|e| format!("config 권한 설정 실패: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn config_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = config_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}
