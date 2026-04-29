import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Terminal } from "@/components/terminal/Terminal";
import {
  EC2_DIAGNOSTIC_LINES,
  EC2_MAIN_LINES,
} from "@/components/terminal/mockContent";

type Props = {
  role: "main" | "diagnostic";
};

export function EC2Panel({ role }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const label = role === "main" ? "EC2 메인" : "EC2 진단";
  const panelId = role === "main" ? "ec2-main" : "ec2-diagnostic";
  const lines = role === "main" ? EC2_MAIN_LINES : EC2_DIAGNOSTIC_LINES;
  const { isFocused, onMouseDown } = usePanelFocus(panelId);

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <span className="text-xs font-semibold text-card-foreground">{label}</span>
        <Button
          size="xs"
          onClick={() => addEvent("USER", `[${label}] Claude에 분석 요청 (Mock)`)}
          className="[&_svg]:text-action-green"
          title="현재 컨텍스트를 좌측 메인 Claude Code 입력창에 주입 (사양서 §4.4)"
        >
          <Send /> 분석 요청
        </Button>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        <Terminal initialLines={lines} />
      </div>
    </div>
  );
}
