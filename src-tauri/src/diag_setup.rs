use std::fs;
use std::path::{Path, PathBuf};

use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

// 원클릭 진단 셋업의 backend 단계 — 키페어 준비 + staging 파일 풀어쓰기.
//
// install.sh 실행과 SFTP 업로드는 frontend가 기존 ssh_exec/sftp_upload IPC를 invoke해 처리한다.
// 그렇게 분리하면 line/done/progress 이벤트 stream을 frontend 진행 모달이 그대로 사용 가능.
//
// 보안 (CLAUDE.md §1.2):
//   - 진단 키페어는 ~/.ssh/sidabari-diag (Unix) / %USERPROFILE%\.ssh\sidabari-diag (Windows)
//   - private 0600, public 0644 (Unix). 디렉토리 0700.
//   - 기존 키페어가 있으면 재사용 (다른 도구가 쓰고 있을 수 있어 함부로 안 건드림).

const INSTALL_SH: &str = include_str!("../../docs/ec2-diag-setup/install.sh");
const COLLECT_SH: &str = include_str!("../../docs/ec2-diag-setup/sidabari-collect.sh");

#[derive(Debug, Deserialize)]
pub struct DiagSetupPrepareOpts {
    /// 비어있으면 ~/.ssh/sidabari-diag로 기본.
    #[serde(default)]
    pub diag_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagSetupPrepareReport {
    pub diag_private_key_path: String,
    pub diag_public_key_path: String,
    pub created_new_keypair: bool,
    pub setup_id: String,
    pub remote_setup_dir: String,
    pub staging_install_path: String,
    pub staging_collect_path: String,
    pub staging_pub_path: String,
}

fn default_diag_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir resolve 실패: {}", e))?;
    Ok(home.join(".ssh").join("sidabari-diag"))
}

fn ensure_keypair(priv_path: &Path, pub_path: &Path) -> Result<(bool, String), String> {
    let priv_exists = priv_path.exists();
    let pub_exists = pub_path.exists();

    // 1) 둘 다 존재 — 재사용.
    if priv_exists && pub_exists {
        let pub_content = fs::read_to_string(pub_path)
            .map_err(|e| format!("기존 .pub 읽기 실패 ({}): {}", pub_path.display(), e))?;
        if pub_content.trim().is_empty() {
            // .pub이 비어 있으면 priv에서 도출 시도 (아래 분기와 동일 경로).
            return derive_pub_from_priv(priv_path, pub_path);
        }
        return Ok((false, pub_content));
    }

    // 2) private만 존재 — priv에서 public 도출. ed25519 OpenSSH는 priv에 pub이 포함됨.
    //    사용자가 .pub을 실수로 삭제했거나, 키 발급 도중 부분 실패한 경우 자동 복구.
    if priv_exists && !pub_exists {
        return derive_pub_from_priv(priv_path, pub_path);
    }

    // 3) public만 존재 — private 없이는 SSH 인증 불가. 자동 복구 불가능.
    if !priv_exists && pub_exists {
        return Err(format!(
            "{}만 존재하고 private 키가 없습니다. private 키 없이는 진단 SSH 인증이 불가합니다. \
            .pub 파일을 백업한 뒤 삭제하고 재시도하세요.",
            pub_path.display()
        ));
    }

    // 4) 둘 다 없음 — 새 ed25519 키페어 생성.
    if let Some(parent) = priv_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("키 디렉토리 생성 실패 ({}): {}", parent.display(), e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    let priv_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .map_err(|e| format!("ed25519 키 생성 실패: {}", e))?;
    let pub_openssh = priv_key
        .public_key()
        .to_openssh()
        .map_err(|e| format!("public 변환 실패: {}", e))?;
    let priv_openssh = priv_key
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("private 변환 실패: {}", e))?;

    let pub_with_comment = format!("{} sidabari-diagnostic\n", pub_openssh.trim_end());

    fs::write(priv_path, priv_openssh.as_bytes())
        .map_err(|e| format!("private 키 쓰기 실패 ({}): {}", priv_path.display(), e))?;
    fs::write(pub_path, pub_with_comment.as_bytes())
        .map_err(|e| format!("public 키 쓰기 실패 ({}): {}", pub_path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(priv_path, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(pub_path, fs::Permissions::from_mode(0o644));
    }

    Ok((true, pub_with_comment))
}

/// 기존 OpenSSH private key에서 public key를 도출하고 .pub 파일을 복원한다.
/// 키페어 자체는 새로 생성한 것이 아니므로 created_new는 false로 반환.
fn derive_pub_from_priv(priv_path: &Path, pub_path: &Path) -> Result<(bool, String), String> {
    let priv_bytes = fs::read(priv_path)
        .map_err(|e| format!("기존 private 키 읽기 실패 ({}): {}", priv_path.display(), e))?;
    let priv_key = PrivateKey::from_openssh(&priv_bytes)
        .map_err(|e| format!("기존 private 키 파싱 실패 ({}): {}", priv_path.display(), e))?;
    let pub_openssh = priv_key
        .public_key()
        .to_openssh()
        .map_err(|e| format!("public 도출 실패: {}", e))?;
    let pub_with_comment = format!("{} sidabari-diagnostic\n", pub_openssh.trim_end());
    fs::write(pub_path, pub_with_comment.as_bytes())
        .map_err(|e| format!("public 키 쓰기 실패 ({}): {}", pub_path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(pub_path, fs::Permissions::from_mode(0o644));
    }
    Ok((false, pub_with_comment))
}

/// 진단 키페어 ensure + staging 디렉토리에 install.sh / sidabari-collect.sh / .pub 풀어쓰기.
/// frontend는 반환된 staging_*_path를 sftp_upload의 local_path로 사용.
#[tauri::command]
pub async fn diag_setup_prepare(
    app: AppHandle,
    opts: DiagSetupPrepareOpts,
) -> Result<DiagSetupPrepareReport, String> {
    let priv_path = if let Some(p) = opts
        .diag_key_path
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        PathBuf::from(p)
    } else {
        default_diag_key_path(&app)?
    };
    let pub_path = priv_path.with_extension("pub");
    let (created_new, pub_content) = ensure_keypair(&priv_path, &pub_path)?;

    let setup_id = Uuid::new_v4().to_string();
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 실패: {}", e))?
        .join("diag-setup-staging")
        .join(&setup_id);
    fs::create_dir_all(&staging_root)
        .map_err(|e| format!("staging 디렉토리 생성 실패 ({}): {}", staging_root.display(), e))?;

    let staging_install = staging_root.join("install.sh");
    let staging_collect = staging_root.join("sidabari-collect.sh");
    let staging_pub = staging_root.join("sidabari-diag.pub");

    fs::write(&staging_install, INSTALL_SH)
        .map_err(|e| format!("install.sh 쓰기 실패: {}", e))?;
    fs::write(&staging_collect, COLLECT_SH)
        .map_err(|e| format!("sidabari-collect.sh 쓰기 실패: {}", e))?;
    fs::write(&staging_pub, pub_content.as_bytes())
        .map_err(|e| format!("sidabari-diag.pub 쓰기 실패: {}", e))?;

    let remote_setup_dir = format!("/tmp/sidabari-diag-setup-{}", setup_id);

    Ok(DiagSetupPrepareReport {
        diag_private_key_path: priv_path.to_string_lossy().to_string(),
        diag_public_key_path: pub_path.to_string_lossy().to_string(),
        created_new_keypair: created_new,
        setup_id,
        remote_setup_dir,
        staging_install_path: staging_install.to_string_lossy().to_string(),
        staging_collect_path: staging_collect.to_string_lossy().to_string(),
        staging_pub_path: staging_pub.to_string_lossy().to_string(),
    })
}

/// 셋업 성공 후 staging 디렉토리 정리 (실패해도 무해 — 무시).
#[tauri::command]
pub async fn diag_setup_cleanup(app: AppHandle, setup_id: String) -> Result<(), String> {
    if setup_id.trim().is_empty() {
        return Err("setup_id 비어있음".to_string());
    }
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 실패: {}", e))?
        .join("diag-setup-staging")
        .join(&setup_id);
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root)
            .map_err(|e| format!("staging 정리 실패: {}", e))?;
    }
    Ok(())
}
