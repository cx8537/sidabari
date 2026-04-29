import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { SshTerminal, type SshConnect } from "@/components/terminal/SshTerminal";
import { ptyWrite } from "@/lib/pty";
import { listenSshData, sshWrite } from "@/lib/ssh";
import { loadConfig } from "@/lib/config";
import { stripAnsi } from "@/lib/ansi";

type Props = {
  role: "main" | "diagnostic";
};

type ConnectState =
  | { status: "loading" }
  | { status: "ready"; connect: SshConnect | null };

// 사양서 §3.6 시점 B — 분석 요청 시 마지막 N라인을 좌측 Claude로 주입.
// "이전 컨텍스트는 Claude Code 대화 히스토리에 의존, 재전송 안 함" — 명령+출력만 단순 전달.
const ANALYZE_TAIL_LINES = 50;
const RING_BUFFER_MAX = 200;

export function EC2Panel({ role }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const mainClaudeSessionId = useAppStore((s) => s.mainClaudeSessionId);
  const mainEc2SessionId = useAppStore((s) => s.mainEc2SessionId);
  const setMainEc2SessionId = useAppStore((s) => s.setMainEc2SessionId);
  const setMainEc2DiagSessionId = useAppStore((s) => s.setMainEc2DiagSessionId);
  const diagPanelOpen = useAppStore((s) => s.diagPanelOpen);
  const setDiagPanelOpen = useAppStore((s) => s.setDiagPanelOpen);
  const label = role === "main" ? "EC2 메인" : "EC2 진단";
  const panelId = role === "main" ? "ec2-main" : "ec2-diagnostic";
  const { isFocused, onMouseDown } = usePanelFocus(panelId);

  // 두 패널 모두 같은 SSH 설정 사용. (진단도 같은 host에 별도 채널.)
  const [conn, setConn] = useState<ConnectState>({ status: "loading" });
  useEffect(() => {
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
  }, []);

  // 자체 패널 sessionId 추적 — 메인은 store(setMainEc2SessionId)에도 반영.
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const handleSessionChange = useCallback(
    (id: string | null) => {
      setLocalSessionId(id);
      if (role === "main") setMainEc2SessionId(id);
      else setMainEc2DiagSessionId(id);
    },
    [role, setMainEc2SessionId, setMainEc2DiagSessionId],
  );

  // 메인 SSH 연결 직후 모니터 명령 자동 입력 (사양서 §3.2 [4]).
  useEffect(() => {
    if (role !== "main") return;
    if (!mainEc2SessionId) return;
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const cmd = c.monitoring.log_command.trim();
        if (!cmd) return;
        sshWrite(mainEc2SessionId, `${cmd}\n`).catch(() => {});
        addEvent("MONITOR", `메인 SSH 연결 — 모니터 명령 자동 입력: ${cmd}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [role, mainEc2SessionId, addEvent]);

  // 패널 SSH stream을 ring buffer로 캡처 — 사양서 §3.6 시점 B 분석 요청용.
  // ANSI strip 후 라인 단위 push (ring max 200줄).
  const ringBufferRef = useRef<string[]>([]);
  const lineBufferRef = useRef<string>("");
  useEffect(() => {
    ringBufferRef.current = [];
    lineBufferRef.current = "";
    if (!localSessionId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenSshData(localSessionId, (chunk) => {
      lineBufferRef.current += stripAnsi(chunk);
      const lines = lineBufferRef.current.split(/\r?\n/);
      lineBufferRef.current = lines.pop() ?? "";
      for (const line of lines) {
        ringBufferRef.current.push(line);
        if (ringBufferRef.current.length > RING_BUFFER_MAX) {
          ringBufferRef.current.shift();
        }
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [localSessionId]);

  async function handleAnalyze() {
    if (!mainClaudeSessionId) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 실패 — 좌측 메인 Claude 세션 비활성.`,
      );
      return;
    }
    const buf = ringBufferRef.current;
    if (buf.length === 0) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 — 캡처된 출력 없음 (SSH 연결 후 명령 실행 필요)`,
      );
      return;
    }
    const tail = buf.slice(-ANALYZE_TAIL_LINES);
    const text = [
      `[${label} 패널 — 마지막 ${tail.length}줄]`,
      ...tail,
    ].join("\n");
    // 사양서 §3.6 — 브라켓 페이스트 (자동 전송 X, 사용자가 검토 후 Enter)
    const wrapped = `\x1b[200~${text}\x1b[201~`;
    try {
      await ptyWrite(mainClaudeSessionId, wrapped);
      addEvent(
        "USER",
        `[${label}] Claude에 분석 요청 (${tail.length}줄 컨텍스트 주입)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[${label}] 분석 요청 실패: ${msg}`);
    }
  }

  const analyzeDisabled = !mainClaudeSessionId;
  const diagDisabled = !mainEc2SessionId; // 메인 SSH 비활성이면 진단 SSH 시작 못 함

  let body: React.ReactNode;
  if (conn.status === "loading") {
    body = (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        설정 불러오는 중...
      </div>
    );
  } else if (conn.connect === null) {
    body = (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        EC2 host / user / 개인키 경로 미설정 — 설정 모달에서 입력 후 재시작
      </div>
    );
  } else {
    body = (
      <SshTerminal connect={conn.connect} onSessionChange={handleSessionChange} />
    );
  }

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <span className="text-xs font-semibold text-card-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          {role === "main" && (
            <Button
              size="xs"
              onClick={() => setDiagPanelOpen(!diagPanelOpen)}
              disabled={diagDisabled}
              className="[&_svg]:text-action-green"
              title={
                diagDisabled
                  ? "메인 SSH 연결 활성 후 진단 가능"
                  : "EC2 진단 패널 팝업 (사양서 §3.3 [D3] — ad-hoc 명령 채널)"
              }
            >
              <Stethoscope /> 진단
            </Button>
          )}
          <Button
            size="xs"
            onClick={handleAnalyze}
            disabled={analyzeDisabled}
            className="[&_svg]:text-action-green"
            title={
              analyzeDisabled
                ? "좌측 메인 Claude 세션이 비활성"
                : `현재 패널의 마지막 ${ANALYZE_TAIL_LINES}줄을 좌측 Claude 입력창에 주입 (사양서 §3.6 시점 B)`
            }
          >
            <Send /> 분석 요청
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">{body}</div>
    </div>
  );
}
