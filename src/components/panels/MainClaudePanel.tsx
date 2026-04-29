import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { PtyTerminal } from "@/components/terminal/PtyTerminal";
import { loadConfig } from "@/lib/config";
import type { SpawnOptions } from "@/lib/pty";
import { useAppStore } from "@/store/useAppStore";

// 사양서 §3.1 / §4.2 / §5.1 — 좌측 메인 Claude Code (작업 지시용).
// 설정의 claude_code_sessions.main을 따라 spawn:
//  - directory가 있으면 cwd로 사용 (없으면 백엔드가 home으로 폴백)
//  - auto_start=true → `claude` 실행, false → OS 기본 셸 (사용자가 수동으로 `claude` 입력)
// 설정 변경은 다음 앱 재시작에 반영 (자동 재시작 X — CLAUDE.md §1.3).

type Resolved = { spawn: SpawnOptions } | { error: string };

export function MainClaudePanel() {
  const { isFocused, onMouseDown } = usePanelFocus("main-claude");
  const setMainClaudeSessionId = useAppStore((s) => s.setMainClaudeSessionId);
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const sess = c.claude_code_sessions.main;
        setResolved({
          spawn: {
            command: sess.auto_start ? "claude" : "",
            cwd: sess.directory || undefined,
          },
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // 설정 로드 실패 → OS 기본 셸로 폴백 (사용자가 수동 진입 가능하도록)
        setResolved({
          spawn: { command: "" },
        });
        console.warn("[MainClaudePanel] config 로드 실패, 기본 셸로 폴백:", message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 rounded-md px-3 py-2 text-xs font-semibold text-card-foreground transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        메인 Claude Code (작업 지시용)
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        {resolved && "spawn" in resolved ? (
          <PtyTerminal
            spawn={resolved.spawn}
            onSessionChange={setMainClaudeSessionId}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            설정 불러오는 중...
          </div>
        )}
      </div>
    </div>
  );
}
