use std::sync::Mutex;

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

// Phase 5a / Task #7 흡수 — Claude Code 훅 이벤트의 영구 적재.
//
// 위치: <app_data>/audit.sqlite3 (events.jsonl과 같은 부모 디렉토리)
//
// 보안 (CLAUDE.md §1.2.7):
//   - DB 파일 권한 0600 (Unix). Windows는 사용자 ACL.
//   - tool_input/tool_result에 사용자 명령·로그 본문이 들어갈 수 있어 외부 노출 금지.
//
// 향후 UI:
//   - 5b/5c 단계에서 SettingsModal 또는 별도 timeline 탭에서 조회.
//   - 본 단계는 적재만 — 즉시 가치는 약하지만 데이터 손실 방지(jsonl rotate 시).

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS hook_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms           INTEGER NOT NULL,
    panel_id        TEXT,
    kind            TEXT NOT NULL,
    hook_event_name TEXT,
    tool_name       TEXT,
    payload_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_events_ts ON hook_events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_hook_events_panel ON hook_events(panel_id);
CREATE INDEX IF NOT EXISTS idx_hook_events_kind ON hook_events(kind);
"#;

pub struct AuditDb {
    conn: Mutex<Connection>,
}

pub fn init(app: &AppHandle) -> Result<AuditDb, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir resolve 실패: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("audit 디렉토리 생성 실패: {}", e))?;
    let db_path = dir.join("audit.sqlite3");
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 열기 실패: {}", e))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("스키마 생성 실패: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(AuditDb {
        conn: Mutex::new(conn),
    })
}

/// hooks_bus의 tail_events가 매 라인마다 호출. 실패해도 흐름 차단 X — stderr 로그만.
pub fn insert(
    db: &AuditDb,
    panel_id: Option<&str>,
    kind: &str,
    hook_event_name: Option<&str>,
    tool_name: Option<&str>,
    payload_json: &str,
) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[audit_log] lock poisoned: {}", e);
            return;
        }
    };
    if let Err(e) = conn.execute(
        "INSERT INTO hook_events (ts_ms, panel_id, kind, hook_event_name, tool_name, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
        params![ts_ms, panel_id, kind, hook_event_name, tool_name, payload_json],
    ) {
        eprintln!("[audit_log] insert 실패: {}", e);
    }
}
