import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Phase 0 — Claude Code 훅 IPC. backend(src-tauri/src/hooks_bus.rs)와 1:1 대응.
//
// 일방향 이벤트: events.jsonl 한 줄 → emit("hook:event", { kind, payload })
// 양방향 게이트: gate.js가 req-<id>.json 작성 → emit("hook:gate-request", ...) → frontend 응답 → resp-<id>.json
//
// "kind"는 hooks_bus의 classify_event가 매핑:
//   "stop" | "pretool" | "posttool" | "notification" | "session-start" | "subagent-stop" | "user-prompt" | "other:<name>"

export type HookKind =
  | "stop"
  | "pretool"
  | "posttool"
  | "notification"
  | "session-start"
  | "subagent-stop"
  | "user-prompt";

/// Claude Code stdin payload + Sidabari가 추가한 _sidabari 메타.
export type HookPayload = {
  // Common
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  // PreToolUse / PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_result?: { output?: string; exitCode?: number };
  // Stop
  stop_hook_active?: boolean;
  // SessionStart
  source?: "startup" | "resume" | "clear" | "compact";
  model?: string;
  // Notification
  notification_type?: string;
  // UserPromptSubmit
  prompt?: string;
  // Sidabari 주입
  _sidabari?: {
    hook_event_name_arg: string;
    panel_id: string | null;
    received_at_ms: number;
  };
};

export type HookEventEmit = {
  kind: string;
  payload: HookPayload;
};

export type GateRequestEmit = {
  request_id: string;
  panel_id: string | null;
  hook_event_name: string;
  payload: HookPayload & { request_id?: string; sent_at_ms?: number };
};

export type HookPaths = {
  base_dir: string;
  append_script: string;
  gate_script: string;
};

export type GateDecision = "allow" | "deny" | "ask" | "defer";

/// 일방향 훅 이벤트 listen.
export async function listenHookEvent(
  handler: (e: HookEventEmit) => void,
): Promise<UnlistenFn> {
  return await listen<HookEventEmit>("hook:event", (e) => handler(e.payload));
}

/// 양방향 게이트 요청 listen.
export async function listenGateRequest(
  handler: (e: GateRequestEmit) => void,
): Promise<UnlistenFn> {
  return await listen<GateRequestEmit>("hook:gate-request", (e) =>
    handler(e.payload),
  );
}

/// 게이트 응답 — gate.js가 폴링 중인 resp-<id>.json 파일 작성.
export async function gateRespond(
  requestId: string,
  decision: GateDecision,
  reason?: string,
): Promise<void> {
  await invoke("hook_gate_respond", { requestId, decision, reason });
}

/// hook 절대경로 조회 (필요 시).
export async function getHookPaths(): Promise<HookPaths> {
  return await invoke<HookPaths>("hook_paths");
}
