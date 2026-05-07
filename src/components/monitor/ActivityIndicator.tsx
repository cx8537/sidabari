import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

// Phase 1 — 패널 타이틀바에 표시할 작은 활성 인디케이터.
// "thinking" → green dot + "작업 중"
// "idle"     → gray dot  + "Idle Ns/m/h"
// 활동 정보 없음 → 아무것도 표시 안 함 (훅 미설치 등).
//
// 시간 포맷: 60s 미만은 초 단위, 60m 미만은 분, 그 외는 시간+분.
// 매초 갱신은 분 미만일 때만 (그 이후는 분 단위라 1분에 한 번만 rerender).

function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

type Props = {
  /** SIDABARI_PANEL_ID와 동일한 키 (예: "main-claude", "claude-tab:<uuid>"). */
  panelKey: string;
};

export function ActivityIndicator({ panelKey }: Props) {
  const activity = useAppStore((s) => s.panelActivity[panelKey]);
  const currentTool = useAppStore((s) => s.panelCurrentTool[panelKey]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activity) return;
    // idle일 때만 매초 갱신 — thinking은 시간 표시 안 하므로 불필요.
    if (activity.state !== "idle") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activity]);

  if (!activity) return null;
  const thinking = activity.state === "thinking";
  // Phase 3 — thinking 중 도구가 활성이면 "도구명 — 요약" 표시. 그 외는 "작업 중" 또는 idle.
  let label: string;
  if (thinking) {
    label = currentTool
      ? `${currentTool.tool}${currentTool.detail ? ` — ${currentTool.detail}` : ""}`
      : "작업 중";
  } else {
    label = `Idle ${formatIdle(now - activity.since)}`;
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground max-w-[24rem] truncate"
      title={label}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          thinking ? "bg-action-green" : "bg-foreground/30",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
