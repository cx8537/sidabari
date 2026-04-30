import { useEffect, useState } from "react";
import { LayoutDashboard, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { PtyTerminal } from "@/components/terminal/PtyTerminal";
import { AddClaudeTabModal } from "@/components/modals/AddClaudeTabModal";
import { DiagnosticDashboard } from "@/components/dashboard/DiagnosticDashboard";
import { loadConfig, saveConfig } from "@/lib/config";

// 사양서 §4.2 / §5.2 — 추가 Claude Code 탭들 + 진단 Dashboard 고정 탭.
// 각 Claude 탭은 directory에서 `claude -c`로 실행. config.claude_code_sessions.additional에 저장 →
// 다음 실행 시 자동으로 살아남.
// Dashboard 탭은 PTY가 아닌 React 컴포넌트(DiagnosticDashboard) — 닫기 버튼 없음, 항상 첫 자리.

const DASHBOARD_TAB_ID = "__dashboard__";

type Tab = {
  // tab 식별자 (PtyTerminal key 안정화 위함). directory를 그대로 쓰면 같은 디렉토리 두 번 추가 시 충돌.
  id: string;
  label: string;
  directory: string;
};

function basename(p: string): string {
  const last = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return last >= 0 ? p.slice(last + 1) : p;
}

export function ClaudeTabsPanel() {
  const { isFocused, onMouseDown } = usePanelFocus("claude-tabs");
  const [tabs, setTabs] = useState<Tab[]>([]);
  // Dashboard 탭이 항상 존재 → 초기 활성 탭은 Dashboard.
  const [activeId, setActiveId] = useState<string>(DASHBOARD_TAB_ID);
  const [addOpen, setAddOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 마운트 시 config의 additional 배열 로드 → 자동 spawn (사양서 §5.1)
  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const arr = c.claude_code_sessions.additional;
        const initial: Tab[] = arr.map((entry) => ({
          id: crypto.randomUUID(),
          label: entry.label.trim() || basename(entry.directory),
          directory: entry.directory,
        }));
        setTabs(initial);
        // Dashboard 탭이 항상 존재 — Claude 탭이 있어도 기본은 Dashboard 유지.
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persistTabs(next: Tab[]) {
    try {
      const cfg = await loadConfig();
      cfg.claude_code_sessions.additional = next.map((t) => ({
        label: t.label,
        directory: t.directory,
        auto_start: true,
      }));
      await saveConfig(cfg);
    } catch {
      // 저장 실패해도 메모리 상태 유지 — 다음 변경 시 재시도. 사용자 안내는 별도 콘솔 이벤트로.
    }
  }

  async function handleAdd(directory: string) {
    const trimmed = directory.trim();
    if (!trimmed) return;
    // 중복 디렉토리는 같은 cwd에서 또 다른 세션으로 spawn — 허용. 사용자가 의도적이면 가능.
    const newTab: Tab = {
      id: crypto.randomUUID(),
      label: basename(trimmed),
      directory: trimmed,
    };
    const next = [...tabs, newTab];
    setTabs(next);
    setActiveId(newTab.id);
    await persistTabs(next);
  }

  async function handleRemove(id: string) {
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id) {
      // 닫힌 탭이 활성이었으면 남은 첫 Claude 탭, 그것도 없으면 Dashboard로.
      setActiveId(next[0]?.id ?? DASHBOARD_TAB_ID);
    }
    await persistTabs(next);
  }

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        {/* Dashboard — 고정 탭. 닫기 버튼 없음, 항상 첫 자리. */}
        <button
          type="button"
          onClick={() => setActiveId(DASHBOARD_TAB_ID)}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
            activeId === DASHBOARD_TAB_ID
              ? "bg-secondary text-secondary-foreground ring-1 ring-ring ring-inset"
              : "text-muted-foreground hover:bg-muted",
          )}
          title="시스템 진단 대시보드 (고정 탭)"
        >
          <LayoutDashboard className="size-3" />
          <span>Dashboard</span>
        </button>

        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveId(tab.id)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
              activeId === tab.id
                ? "bg-secondary text-secondary-foreground ring-1 ring-ring ring-inset"
                : "text-muted-foreground hover:bg-muted",
            )}
            title={tab.directory}
          >
            <span className="max-w-[12rem] truncate">{tab.label}</span>
            <X
              className="size-3 opacity-50 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void handleRemove(tab.id);
              }}
            />
          </button>
        ))}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-1 rounded-full bg-foreground/15 hover:bg-foreground/25"
          title="새 탭"
          onClick={() => setAddOpen(true)}
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 mx-0.5 relative">
        {/* Dashboard 탭 — 항상 마운트되어 있되 활성일 때만 보임. */}
        <div
          className={cn(
            "absolute inset-0",
            activeId === DASHBOARD_TAB_ID
              ? "visible"
              : "invisible pointer-events-none",
          )}
        >
          <DiagnosticDashboard />
        </div>

        {!loaded ? (
          activeId !== DASHBOARD_TAB_ID && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              설정 불러오는 중...
            </div>
          )
        ) : (
          // 모든 Claude 탭 mount 유지 (활성만 보이게). PtyTerminal unmount = SSH/PTY 종료라 비활성에도 살아있어야.
          // 재시작 시 메인 + 모든 탭이 한 frame에 동시 spawn되면 claude의 lock/credentials 충돌이
          // 발생해 일부 인스턴스가 silent fail하는 경우 — 인덱스별 시차로 race 회피.
          tabs.map((tab, idx) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                activeId === tab.id ? "visible" : "invisible pointer-events-none",
              )}
            >
              <PtyTerminal
                spawn={{
                  command: "claude",
                  args: ["-c"],
                  cwd: tab.directory,
                }}
                spawnDelayMs={(idx + 1) * 1500}
              />
            </div>
          ))
        )}
      </div>
      <AddClaudeTabModal open={addOpen} onOpenChange={setAddOpen} onAdd={handleAdd} />
    </div>
  );
}
