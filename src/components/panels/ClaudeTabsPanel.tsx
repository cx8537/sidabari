import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Terminal } from "@/components/terminal/Terminal";
import { CLAUDE_TAB_LINES } from "@/components/terminal/mockContent";

const MOCK_TABS = [
  { id: "1", label: "프론트엔드" },
  { id: "2", label: "백엔드" },
];

export function ClaudeTabsPanel() {
  const [activeId, setActiveId] = useState("1");
  const { isFocused, onMouseDown } = usePanelFocus("claude-tabs");

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        {MOCK_TABS.map((tab) => (
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
          >
            {tab.label}
            <X className="size-3 opacity-50 hover:opacity-100" />
          </button>
        ))}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-1 rounded-full bg-foreground/15 hover:bg-foreground/25"
          title="새 탭"
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        <Terminal key={activeId} initialLines={CLAUDE_TAB_LINES[activeId]} />
      </div>
    </div>
  );
}
