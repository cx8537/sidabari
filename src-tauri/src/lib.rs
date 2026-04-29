mod build;
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
        .manage(Arc::new(pty::PtyState::default()))
        .manage(Arc::new(ssh::SshState::default()))
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
            ssh_exec::ssh_exec,
            build::build_start,
            build::build_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
