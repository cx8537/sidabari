import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Terminal } from "@/components/terminal/Terminal";
import { MAIN_CLAUDE_LINES } from "@/components/terminal/mockContent";

export function MainClaudePanel() {
  const { isFocused, onMouseDown } = usePanelFocus("main-claude");

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
        <Terminal initialLines={MAIN_CLAUDE_LINES} />
      </div>
    </div>
  );
}
