import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { loadConfig } from "@/lib/config";

// 사양서 §3.7 — SSH 끊김 grace 정책.
// attempt 진행 중 메인 SSH 채널이 끊기면 N초 grace 후 사용자가 [재연결]로 복구하지 않으면
// attempt를 FAILED_INFRA로 마킹. attempt와 무관한 끊김(idle/succeeded 등)에는 적용 X —
// 평상시 사용자 자유 [재연결].
//
// 자동 재시도 금지(§1.3) 정신과 §3.7 grace 사이의 절충: grace 동안은 timer만 돌고
// 자동 reconnect 시도는 하지 않음. 사용자가 명시적으로 [재연결] 버튼 클릭해야 복구.
// SshTerminal의 stream close → onSessionChange(null) → store mainEc2SessionId=null 트리거.
//
// UI 없음. App.tsx에 1회 마운트.

const FALLBACK_GRACE_SECONDS = 10;

export function SshGraceWatcher() {
  const status = useAppStore((s) => s.attemptStatus);
  const sessionId = useAppStore((s) => s.mainEc2SessionId);
  const finishAttempt = useAppStore((s) => s.finishAttempt);
  const addEvent = useAppStore((s) => s.addEvent);

  useEffect(() => {
    // attempt running + 메인 SSH 끊김 상태에서만 grace 발동
    if (status !== "running" || sessionId !== null) return;

    let cancelled = false;
    let timer: number | null = null;

    (async () => {
      // grace 초는 config 우선, 실패 시 fallback 10초
      let graceSec = FALLBACK_GRACE_SECONDS;
      try {
        const cfg = await loadConfig();
        const v = cfg.safety.ssh_disconnect_grace_seconds;
        if (Number.isFinite(v) && v > 0) graceSec = v;
      } catch {
        // 무시 — fallback
      }
      if (cancelled) return;

      addEvent(
        "MONITOR",
        `메인 SSH 끊김 — ${graceSec}초 grace 시작 (사양서 §3.7). 그 안에 [재연결]하지 않으면 attempt가 FAILED_INFRA로 종료됩니다.`,
      );
      timer = window.setTimeout(() => {
        addEvent(
          "MONITOR",
          `[FAILED_INFRA] SSH 끊김 ${graceSec}초 grace 초과 — attempt 종료`,
        );
        finishAttempt(false);
      }, graceSec * 1000);
    })();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        // sessionId가 다시 set된 케이스: grace 안에 복구된 것 → 사용자에게 알림
        if (status === "running") {
          addEvent("SYSTEM", "메인 SSH 복구 — grace 취소, attempt 진행");
        }
      }
    };
  }, [status, sessionId, finishAttempt, addEvent]);

  return null;
}
