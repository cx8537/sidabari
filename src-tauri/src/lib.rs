mod config;
mod pty;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(pty::PtyState::default()))
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            config::config_path,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
