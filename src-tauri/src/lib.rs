mod audit_log;
mod build;
mod claude_safety;
mod config;
mod diag_setup;
mod diag_ssh_allow;
mod hook_installer;
mod hooks_bus;
mod known_hosts;
mod pty;
mod sftp;
mod ssh;
mod ssh_exec;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(pty::PtyState::default()))
        .manage(Arc::new(ssh::SshState::default()))
        .manage(Arc::new(ssh_exec::ExecState::default()))
        .manage(Arc::new(sftp::SftpState::default()))
        .manage(Arc::new(build::BuildState::default()))
        .setup(|app| {
            // Phase 5a — audit DB가 hooks_bus 보다 먼저 init되어야 한다 (tail_events가 참조).
            match audit_log::init(app.handle()) {
                Ok(db) => {
                    app.manage(Arc::new(db));
                }
                Err(e) => {
                    eprintln!("[lib] audit_log init 실패 — 영구 적재 비활성: {}", e);
                }
            }
            // Phase 0 — Claude Code 훅 IPC 부트.
            // 실패 시 앱은 계속 동작하되 훅 기능 비활성. (CLAUDE.md §1.3 자동 재시도 X)
            match hooks_bus::init(app.handle()) {
                Ok(bus) => {
                    app.manage(Arc::new(bus));
                }
                Err(e) => {
                    eprintln!("[lib] hooks_bus init 실패 — 훅 기능 비활성: {}", e);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            config::config_path,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_accept_host_key,
            sftp::sftp_upload,
            sftp::sftp_upload_kill,
            ssh_exec::ssh_exec,
            ssh_exec::ssh_exec_kill,
            ssh_exec::ssh_collect_exec,
            ssh_exec::ssh_collect_kill,
            build::build_start,
            build::build_kill,
            claude_safety::install_claude_safety_rules,
            claude_safety::claude_safety_rules_status,
            hook_installer::install_claude_hooks,
            hook_installer::claude_hooks_status,
            hooks_bus::hook_gate_respond,
            hooks_bus::hook_paths,
            diag_ssh_allow::install_diag_ssh_allow,
            diag_ssh_allow::remove_diag_ssh_allow,
            diag_ssh_allow::diag_ssh_allow_status,
            diag_setup::diag_setup_prepare,
            diag_setup::diag_setup_cleanup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
