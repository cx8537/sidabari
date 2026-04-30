mod build;
mod claude_safety;
mod config;
mod known_hosts;
mod pty;
mod sftp;
mod ssh;
mod ssh_exec;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Arc::new(pty::PtyState::default()))
        .manage(Arc::new(ssh::SshState::default()))
        .manage(Arc::new(ssh_exec::ExecState::default()))
        .manage(Arc::new(sftp::SftpState::default()))
        .manage(Arc::new(build::BuildState::default()))
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
            build::build_start,
            build::build_kill,
            claude_safety::install_claude_safety_rules,
            claude_safety::claude_safety_rules_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
