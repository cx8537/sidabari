import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Terminal } from "@/components/terminal/Terminal";
import { SshTerminal, type SshConnect } from "@/components/terminal/SshTerminal";
import { ptyWrite } from "@/lib/pty";
import { loadConfig } from "@/lib/config";
import { EC2_DIAGNOSTIC_LINES } from "@/components/terminal/mockContent";

type Props = {
  role: "main" | "diagnostic";
};

// 사양서 §3.6 — 분석 요청 텍스트 주입 (브라켓 페이스트). SSH 미캡처 단계라 컨텍스트는 mock.
function buildMockContext(label: string): string {
  return [
    `[${label} 패널 컨텍스트 — Mock]`,
    `(SSH 미캡처. 실제 ERROR + Caused by 체인 + 명령 출력 캡처는 task #6 이후)`,
    `※ 사양서 §3.6 시점 A/B 형식으로 구성 예정.`,
  ].join("\n");
}

type ConnectState =
  | { status: "loading" }
  | { status: "ready"; connect: SshConnect | null };

export function EC2Panel({ role }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const mainClaudeSessionId = useAppStore((s) => s.mainClaudeSessionId);
  const label = role === "main" ? "EC2 메인" : "EC2 진단";
  const panelId = role === "main" ? "ec2-main" : "ec2-diagnostic";
  const { isFocused, onMouseDown } = usePanelFocus(panelId);

  // 메인 패널만 SSH 연결 정보 로드 (사양서 §3.2 — 진단은 stage 5a-2에서).
  const [conn, setConn] = useState<ConnectState>({ status: "loading" });
  useEffect(() => {
    if (role !== "main") return;
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const ec2 = c.ec2;
        const valid =
          ec2.host.trim() !== "" &&
          ec2.user.trim() !== "" &&
          ec2.private_key_path.trim() !== "";
        setConn({
          status: "ready",
          connect: valid
            ? {
                host: ec2.host,
                port: ec2.port,
                user: ec2.user,
                private_key_path: ec2.private_key_path,
              }
            : null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setConn({ status: "ready", connect: null });
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  async function handleAnalyze() {
    if (!mainClaudeSessionId) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 실패 — 좌측 메인 Claude 세션 비활성.`,
      );
      return;
    }
    const context = buildMockContext(label);
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
              ? "좌측 메인 Claude 세션이 비활성"
              : "현재 컨텍스트를 좌측 메인 Claude Code 입력창에 주입 (사양서 §3.6 / §4.4)"
          }
        >
          <Send /> 분석 요청
        </Button>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        {role === "main" ? (
          conn.status === "loading" ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              설정 불러오는 중...
            </div>
          ) : (
            <SshTerminal connect={conn.connect} />
          )
        ) : (
          <Terminal initialLines={EC2_DIAGNOSTIC_LINES} />
        )}
      </div>
    </div>
  );
}
