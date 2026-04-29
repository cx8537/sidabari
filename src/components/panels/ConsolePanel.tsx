import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useAppStore, type ConsoleEvent } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function sourceColor(source: string): string {
  switch (source) {
    case "USER":
      return "text-foreground";
    case "SYSTEM":
      return "text-muted-foreground";
    case "BUILD":
    case "UPLOAD":
    case "DEPLOY":
      return "text-accent-gold";
    case "MONITOR":
      return "text-destructive";
    default:
      return "text-foreground";
  }
}

function ConsoleLine({ event }: { event: ConsoleEvent }) {
  return (
    <div className="font-mono text-xs leading-relaxed">
      <span className="text-muted-foreground">[{formatTime(event.timestamp)}]</span>
      <span className={cn("ml-2 font-semibold", sourceColor(event.source))}>
        [{event.source}]
      </span>
      <span className="ml-2 break-words">{event.message}</span>
    </div>
  );
}

export function ConsolePanel() {
  const events = useAppStore((s) => s.consoleEvents);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isFocused, onMouseDown } = usePanelFocus("console");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 rounded-md px-3 py-2 text-xs font-semibold text-card-foreground transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        도구 콘솔
      </div>
      <div ref={scrollRef} className="flex-1 space-y-0.5 overflow-auto px-3 py-2">
        {events.map((e) => (
          <ConsoleLine key={e.id} event={e} />
        ))}
      </div>
    </div>
  );
}
