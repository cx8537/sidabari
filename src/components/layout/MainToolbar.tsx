import { useState } from "react";
import { Play, Settings, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore, type AttemptStatus } from "@/store/useAppStore";
import { SettingsModal } from "@/components/modals/SettingsModal";

function statusColor(status: AttemptStatus): string {
  switch (status) {
    case "running":
      return "text-accent-gold";
    case "aborted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function MainToolbar() {
  const status = useAppStore((s) => s.attemptStatus);
  const startAttempt = useAppStore((s) => s.startAttempt);
  const abortAttempt = useAppStore((s) => s.abortAttempt);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isRunning = status === "running";

  return (
    <header className="flex items-center gap-2 bg-card px-3 py-2">
      <span className="mr-2 text-sm font-semibold text-accent-gold">또돌이</span>
      <span className="text-xs text-[#E4E6EA]">
        상태: <span className={cn("font-medium", statusColor(status))}>{status}</span>
      </span>
      <div aria-hidden="true" className="h-5 w-px bg-foreground/20" />
      <Button
        size="sm"
        onClick={startAttempt}
        disabled={isRunning}
        className="[&_svg]:text-action-green"
        title="새 Attempt 시작 (사양서 §3.1)"
      >
        <Play /> 시도 시작
      </Button>
      <Button
        size="sm"
        onClick={abortAttempt}
        disabled={!isRunning}
        className="[&_svg]:text-destructive"
        title="진행 중 Attempt 강제 중단 (Ctrl+C 전송, SSH 채널 유지)"
      >
        <Square /> 강제 중단
      </Button>
      <div aria-hidden="true" className="h-5 w-px bg-foreground/20" />
      <Button size="icon-sm" onClick={() => setSettingsOpen(true)} title="설정">
        <Settings />
      </Button>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
