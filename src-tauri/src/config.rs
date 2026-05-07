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
    // 진단 대상 systemd 서비스 이름. 빈 문자열이면 [자료 일괄 수집] 비활성.
    // 사용자가 설정 UI에서 입력. 진단 명령 템플릿/Dashboard 헤더/MainClaudePanel 프롬프트가 이 값을 참조.
    pub service_name: String,
    // 자료 일괄 수집 명령 오버라이드. 빈 문자열이면 lib/diagnostic.ts의 내장 JVM/Spring Boot 템플릿 사용.
    // 비어있지 않으면 그대로 셸에 전달되며 `{service}` placeholder가 service_name으로 치환됨.
    pub collect_command: String,
    pub log_command: String,
    pub error_pattern: String,
    pub context_lines_before: u32,
    pub context_lines_after: u32,
    pub context_capture_delay_seconds: u32,
}

impl Default for MonitoringConfig {
    fn default() -> Self {
        Self {
            service_name: String::new(),
            collect_command: String::new(),
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

// Phase 0 — UI 토글. 콘솔 verbose 미러링 등 사용자 환경 설정.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub verbose_hook_logs: bool,
    /// Phase 4 — Bash 도구 호출 시 PreToolUse 게이트 모달 활성 (기본 off).
    pub gate_dangerous_tools: bool,
    /// 설정 변경([훅 설치]/[진단 SSH 자동 허용 등록]/[안전 규칙 설치]) 후 모든 Claude PTY를
    /// 자동 재시작해 새 settings.local.json을 즉시 반영 (기본 off, 사용자 명시 옵트인).
    /// CLAUDE.md §1.3 "자동 재시도 금지"는 실패 시 자동 retry — 사용자 액션 후 명시 동의에 의한
    /// 재시작은 별개로 본다.
    pub auto_restart_claude_after_settings_change: bool,
    /// EC2 SSH 패널의 출력에서 ec2.host 문자열을 마스킹 (기본 off).
    /// 캡처/공유 직전에만 켜는 용도 — 평소 OFF 유지 권장 (운영 가시성 감소).
    pub mask_ec2_ips: bool,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            verbose_hook_logs: false,
            gate_dangerous_tools: false,
            auto_restart_claude_after_settings_change: false,
            mask_ec2_ips: false,
        }
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
    pub ui: UiConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 1,
            display_name: "Sidabari".to_string(),
            project: Project::default(),
            claude_code_sessions: ClaudeCodeSessions::default(),
            ec2: Ec2Config::default(),
            sftp: SftpConfig::default(),
            deploy: DeployConfig::default(),
            monitoring: MonitoringConfig::default(),
            safety: SafetyConfig::default(),
            ui: UiConfig::default(),
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
