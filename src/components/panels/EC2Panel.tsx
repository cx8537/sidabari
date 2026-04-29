import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Terminal } from "@/components/terminal/Terminal";
import { ptyWrite } from "@/lib/pty";
import {
  EC2_DIAGNOSTIC_LINES,
  EC2_MAIN_LINES,
} from "@/components/terminal/mockContent";

type Props = {
  role: "main" | "diagnostic";
};

// 사양서 §3.6 — 분석 요청 텍스트 주입 (브라켓 페이스트 모드).
// claude TUI 입력창에 자동 전송되지 않고 paste된 상태로 머무름 — 사용자가 검토 후 Enter.
// SSH 미연결 단계라 컨텍스트는 mock. 실제 컨텍스트 캡처는 task #5(SSH) 이후.
function buildMockContext(label: string): string {
  return [
    `[${label} 패널 컨텍스트 — Mock]`,
    `(SSH 미연결 단계. 실제 ERROR + Caused by 체인 + 명령 출력은 task #5 이후 활성화)`,
    `※ 사양서 §3.6 시점 A/B 형식으로 구성 예정.`,
  ].join("\n");
}

export function EC2Panel({ role }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const mainClaudeSessionId = useAppStore((s) => s.mainClaudeSessionId);
  const label = role === "main" ? "EC2 메인" : "EC2 진단";
  const panelId = role === "main" ? "ec2-main" : "ec2-diagnostic";
  const lines = role === "main" ? EC2_MAIN_LINES : EC2_DIAGNOSTIC_LINES;
  const { isFocused, onMouseDown } = usePanelFocus(panelId);

  async function handleAnalyze() {
    if (!mainClaudeSessionId) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 실패 — 좌측 메인 Claude 세션이 활성 상태가 아닙니다.`,
      );
      return;
    }
    const context = buildMockContext(label);
    // 브라켓 페이스트 모드 시퀀스로 감싸 자동 전송 방지.
    // claude TUI는 paste로 인식해 입력창에 텍스트만 채움 → 사용자가 검토/편집 후 Enter.
    // 일반 셸도 동일 시퀀스를 paste로 처리 (지원 안 하면 raw escape가 보일 수 있으나 mock 단계 OK).
    const wrapped = `\x1b[200~${context}\x1b[201~`;
    try {
      await ptyWrite(mainClaudeSessionId, wrapped);
      addEvent("USER", `[${label}] Claude에 분석 요청 (mock 컨텍스트 주입)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[${label}] 분석 요청 실패: ${msg}`);
    }
  }

  const disabled = !mainClaudeSessionId;

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
          onClick={handleAnalyze}
          disabled={disabled}
          className="[&_svg]:text-action-green"
          title={
            disabled
              ? "좌측 메인 Claude 세션이 비활성 — PTY 시작 후 가능"
              : "현재 컨텍스트를 좌측 메인 Claude Code 입력창에 주입 (사양서 §3.6 / §4.4)"
          }
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
