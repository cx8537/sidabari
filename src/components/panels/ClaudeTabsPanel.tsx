import { useEffect, useRef, useState } from "react";
import { LayoutDashboard, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { PtyTerminal } from "@/components/terminal/PtyTerminal";
import { AddClaudeTabModal } from "@/components/modals/AddClaudeTabModal";
import { DiagnosticDashboard } from "@/components/dashboard/DiagnosticDashboard";
import { loadConfig, saveConfig } from "@/lib/config";
import { useAppStore } from "@/store/useAppStore";
import { listenHookEvent } from "@/lib/hooks";

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

// Phase 1 — 탭 라벨 옆에 thinking 상태일 때 작은 점 표시.
// 탭 자체가 selector를 호출하므로 별도 컴포넌트로 분리해 리렌더 범위 좁힌다.
function ClaudeTabButton({
  tab,
  active,
  onSelect,
  onRemove,
}: {
  tab: Tab;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const activity = useAppStore((s) => s.panelActivity[`claude-tab:${tab.id}`]);
  const thinking = activity?.state === "thinking";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
        active
          ? "bg-secondary text-secondary-foreground ring-1 ring-ring ring-inset"
          : "text-muted-foreground hover:bg-muted",
      )}
      title={tab.directory}
    >
      <span className="max-w-[12rem] truncate">{tab.label}</span>
      {thinking && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-action-green"
          title="Claude 작업 중"
        />
      )}
      <X
        className="size-3 opacity-50 hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      />
    </button>
  );
}

export function ClaudeTabsPanel() {
  const { isFocused, onMouseDown } = usePanelFocus("claude-tabs");
  const claudeRestartKey = useAppStore((s) => s.claudeRestartKey);
  const [tabs, setTabs] = useState<Tab[]>([]);
  // Dashboard 탭이 항상 존재 → 초기 활성 탭은 Dashboard.
  const [activeId, setActiveId] = useState<string>(DASHBOARD_TAB_ID);
  const [addOpen, setAddOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Phase 6b — config 자동로드 탭들은 직렬화. mountedCount 만큼 PtyTerminal 마운트.
  // 첫 SessionStart 훅 도착 또는 5초 timeout 시 다음 탭 진전.
  // 훅 미설치 시에도 timeout으로 자동 폴백 → 기존 spawnDelayMs 시차 효과 유지.
  const [mountedCount, setMountedCount] = useState(0);
  const tabsRef = useRef<Tab[]>([]);

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
        tabsRef.current = initial;
        // 첫 탭만 즉시 mount, 나머지는 SessionStart/timeout으로 점진 진전.
        setMountedCount(initial.length > 0 ? 1 : 0);
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

  // 일괄 재시작 시 직렬화 재가동 — 모든 탭 unmount(key 변경) + 다음 frame에 첫 탭부터 다시 mount.
  useEffect(() => {
    if (claudeRestartKey === 0) return;
    setMountedCount(0);
    const t = window.setTimeout(() => {
      setMountedCount(tabsRef.current.length > 0 ? 1 : 0);
    }, 0);
    return () => window.clearTimeout(t);
  }, [claudeRestartKey]);

  // Phase 6b — SessionStart 진전 + 5초 timeout 폴백.
  useEffect(() => {
    if (mountedCount === 0 || mountedCount >= tabs.length) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const advance = () =>
      setMountedCount((c) => Math.min(tabsRef.current.length, c + 1));

    // 훅 미설치 등으로 SessionStart가 안 와도 자동 폴백.
    const timer = window.setTimeout(advance, 5000);

    listenHookEvent((e) => {
      if (cancelled) return;
      if (e.kind !== "session-start") return;
      const p = e.payload._sidabari?.panel_id ?? "";
      const expected = tabsRef.current[mountedCount - 1];
      if (!expected) return;
      if (p === `claude-tab:${expected.id}`) advance();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[ClaudeTabsPanel] hook listen 실패:", err));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [mountedCount, tabs.length]);

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
    tabsRef.current = next;
    // 사용자가 명시적으로 추가한 탭은 즉시 mount (직렬화 대상은 자동 로드된 탭들만).
    setMountedCount(next.length);
    setActiveId(newTab.id);
    await persistTabs(next);
  }

  async function handleRemove(id: string) {
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    tabsRef.current = next;
    setMountedCount((c) => Math.min(c, next.length));
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
          <ClaudeTabButton
            key={tab.id}
            tab={tab}
            active={activeId === tab.id}
            onSelect={() => setActiveId(tab.id)}
            onRemove={() => void handleRemove(tab.id)}
          />
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
          // Phase 6b — 자동 로드된 탭들은 SessionStart/5초 timeout으로 점진 mount (claude lock race 정공법).
          // 사용자가 [+]로 추가한 탭은 handleAdd가 mountedCount를 즉시 끌어올려 곧바로 spawn.
          tabs.map((tab, idx) => {
            const mounted = idx < mountedCount;
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  activeId === tab.id ? "visible" : "invisible pointer-events-none",
                )}
              >
                {mounted ? (
                  <PtyTerminal
                    // restartAllClaudes()로 카운터 증가 시 unmount/remount → 새 spawn.
                    key={claudeRestartKey}
                    spawn={{
                      command: "claude",
                      args: ["-c"],
                      cwd: tab.directory,
                      // Phase 0 — Claude 훅이 패널을 식별하도록 ENV 주입.
                      env: { SIDABARI_PANEL_ID: `claude-tab:${tab.id}` },
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    이전 탭 시작 대기 중...
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <AddClaudeTabModal open={addOpen} onOpenChange={setAddOpen} onAdd={handleAdd} />
    </div>
  );
}
