import { useEffect, useRef } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { listenHookEvent, type HookEventEmit, type HookPayload } from "@/lib/hooks";
import { useAppStore } from "@/store/useAppStore";
import { loadConfig } from "@/lib/config";

// Phase 2 — Notification 훅 → 데스크톱 토스트.
// 권한 결과는 모듈 레벨로 캐시 (앱 수명 동안 한 번만 요청). 거부되면 이후 토스트 생략.
let notificationPermissionPromise: Promise<boolean> | null = null;

function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationPermissionPromise) {
    notificationPermissionPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        const r = await requestPermission();
        return r === "granted";
      } catch (e) {
        console.warn("[HookBridge] notification 권한 확인 실패:", e);
        return false;
      }
    })();
  }
  return notificationPermissionPromise;
}

async function sendDesktopToast(panel: string, payload: HookPayload) {
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  const subtype = payload.notification_type ?? "알림";
  const tail =
    typeof (payload as { message?: unknown }).message === "string"
      ? ` — ${(payload as { message: string }).message.slice(0, 120)}`
      : "";
  try {
    await sendNotification({
      title: `또돌이 — ${panel}`,
      body: `${subtype}${tail}`,
    });
  } catch (e) {
    console.warn("[HookBridge] sendNotification 실패:", e);
  }
}

// Phase 0 — 훅 이벤트를 콘솔(useAppStore.consoleEvents)에 미러링한다.
//
// 항상 콘솔에 찍히는 항목 (info):
//   - SessionStart
//   - Stop (turn 종료)
//   - Notification
//
// verbose=true일 때만 추가로 찍히는 항목:
//   - PreToolUse / PostToolUse (도구 호출 전후)
//   - subagent-stop, user-prompt
//
// verbose 설정은 마운트 시점에 한 번 로드. CLAUDE.md §1.3 정책 — 설정 변경은 다음 앱 재시작에 반영.
//
// 이 컴포넌트는 App.tsx 루트에 한 번만 렌더 (Listen 등록을 한 번만 하기 위함).

function panelLabel(p: HookPayload): string {
  return p._sidabari?.panel_id ?? "?";
}

function summary(payload: HookPayload): string {
  if (payload.tool_name) {
    const toolName = payload.tool_name;
    const input = payload.tool_input;
    if (input && typeof input === "object") {
      if (typeof (input as { command?: unknown }).command === "string") {
        const cmd = (input as { command: string }).command;
        return `${toolName}: ${cmd.slice(0, 80)}${cmd.length > 80 ? "..." : ""}`;
      }
      if (typeof (input as { file_path?: unknown }).file_path === "string") {
        const fp = (input as { file_path: string }).file_path;
        return `${toolName}: ${fp}`;
      }
    }
    return toolName;
  }
  if (payload.notification_type) return payload.notification_type;
  if (payload.source) return `source=${payload.source}`;
  return "";
}

export function HookBridge() {
  const addEvent = useAppStore((s) => s.addEvent);
  const setPanelActivity = useAppStore((s) => s.setPanelActivity);
  const setPanelCurrentTool = useAppStore((s) => s.setPanelCurrentTool);
  const clearPanelCurrentTool = useAppStore((s) => s.clearPanelCurrentTool);
  const verboseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    loadConfig()
      .then((cfg) => {
        if (cancelled) return;
        verboseRef.current = cfg.ui?.verbose_hook_logs ?? false;
      })
      .catch(() => {
        // 설정 로드 실패해도 listen 계속 — verbose만 false 유지.
      });

    listenHookEvent((e: HookEventEmit) => {
      const { kind, payload } = e;
      const panel = panelLabel(payload);
      const panelKey = payload._sidabari?.panel_id;
      const verbose = verboseRef.current;
      switch (kind) {
        case "stop":
          if (panelKey) {
            setPanelActivity(panelKey, "idle");
            // turn 종료 시 currentTool 정보는 의미 없음 → clear (Idle "Bash..." 표시 방지).
            clearPanelCurrentTool(panelKey);
          }
          addEvent("HOOK", `panel=${panel} turn 종료`);
          break;
        case "session-start":
          if (panelKey) setPanelActivity(panelKey, "thinking");
          addEvent(
            "HOOK",
            `panel=${panel} session 시작${payload.source ? ` (${payload.source})` : ""}`,
          );
          break;
        case "notification":
          // 활동 상태에 영향 X. Phase 2 — 데스크톱 토스트 (사용자 권한 허용 시).
          void sendDesktopToast(panel, payload);
          addEvent(
            "HOOK",
            `panel=${panel} notification${
              payload.notification_type ? `: ${payload.notification_type}` : ""
            }`,
          );
          break;
        case "pretool":
          if (panelKey) {
            setPanelActivity(panelKey, "thinking");
            if (payload.tool_name) {
              setPanelCurrentTool(panelKey, payload.tool_name, summary(payload));
            }
          }
          if (verbose) {
            addEvent("HOOK", `panel=${panel} PreToolUse → ${summary(payload)}`);
          }
          break;
        case "posttool":
          // currentTool은 다음 PreToolUse가 갱신할 때까지 유지 (마지막 도구 보이게, 깜박임 방지).
          if (panelKey) setPanelActivity(panelKey, "thinking");
          if (verbose) {
            const exitCode = payload.tool_result?.exitCode;
            const tail = exitCode !== undefined ? ` (exit=${exitCode})` : "";
            addEvent("HOOK", `panel=${panel} PostToolUse ← ${summary(payload)}${tail}`);
          }
          break;
        case "subagent-stop":
          // subagent 종료는 메인 turn은 계속될 수 있어 idle 전환 X.
          if (verbose) addEvent("HOOK", `panel=${panel} subagent 종료`);
          break;
        case "user-prompt":
          if (panelKey) setPanelActivity(panelKey, "thinking");
          if (verbose) {
            const p = payload.prompt ?? "";
            addEvent(
              "HOOK",
              `panel=${panel} 사용자 입력: ${p.slice(0, 60)}${p.length > 60 ? "..." : ""}`,
            );
          }
          break;
        default:
          if (verbose) addEvent("HOOK", `panel=${panel} ${kind}`);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.warn("[HookBridge] listen 등록 실패:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addEvent]);

  return null;
}
