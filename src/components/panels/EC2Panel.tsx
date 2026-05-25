import { useCallback, useEffect, useRef, useState } from "react";
import { History, ListChecks, Send, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import {
  SshTerminal,
  type SshConnect,
  type SshTerminalApi,
} from "@/components/terminal/SshTerminal";
import { ptyWrite } from "@/lib/pty";
import { listenSshData, sshWrite } from "@/lib/ssh";
import { loadConfig } from "@/lib/config";
import { stripAnsi } from "@/lib/ansi";
import { build24hErrorsCommand, buildCollectCommand } from "@/lib/diagnostic";
import {
  END_MARKER,
  extractCompletedSegment,
  parseDiagnosticOutput,
} from "@/lib/parseDiagnostic";

type Props = {
  role: "main" | "diagnostic";
};

type ConnectState =
  | { status: "loading" }
  | { status: "ready"; connect: SshConnect | null };

// 사양서 §3.6 시점 B — 분석 요청 시 현재 터미널 화면(xterm 버퍼)을 좌측 Claude로 주입.
// "이전 컨텍스트는 Claude Code 대화 히스토리에 의존, 재전송 안 함" — 명령+출력만 단순 전달.
// 우리 별도 ring buffer를 두지 않고 xterm 본인 버퍼를 직접 읽음 → clear 시 자연스럽게 비어있음
// (SshTerminal은 \x1b[2J 들어오면 \x1b[3J(scrollback erase)도 함께 실행하도록 augmentation 함).
// 너무 큰 출력 방지 위해 마지막 N줄로 cap.
const ANALYZE_TAIL_LINES = 500;

// Dashboard 자동 갱신용 — 자료 일괄 수집 종료 마커가 보일 때까지 SSH stream을 누적해 파싱.
// 200KB 정도면 jstack/journalctl 포함한 일괄 수집 결과를 충분히 담음.
// 더 길어지면 옛 텍스트부터 잘라내어 메모리 폭주 방지.
const COLLECT_BUFFER_MAX = 200_000;

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
        addEvent("SYSTEM", `메인 SSH 연결 — 모니터 명령 자동 입력: ${cmd}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [role, mainEc2SessionId, addEvent]);

  // 분석 요청 시 xterm 본인 버퍼를 직접 읽기 위한 API ref. SshTerminal이 채워줌.
  const sshApiRef = useRef<SshTerminalApi | null>(null);

  // Dashboard 갱신용 — 진단 패널 SSH stream에서 [자료 일괄 수집 종료] 마커 감지 시 파싱.
  // 진단 역할만 활성. 메인 패널은 주로 journalctl tail이라 노이즈 큼.
  const collectBufferRef = useRef<string>("");
  const setLatestDiagnostic = useAppStore((s) => s.setLatestDiagnostic);
  useEffect(() => {
    if (role !== "diagnostic") return;
    if (!localSessionId) return;
    collectBufferRef.current = "";
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenSshData(localSessionId, (chunk) => {
      collectBufferRef.current += stripAnsi(chunk);
      if (collectBufferRef.current.length > COLLECT_BUFFER_MAX) {
        collectBufferRef.current = collectBufferRef.current.slice(
          -COLLECT_BUFFER_MAX,
        );
      }
      // 종료 마커 감지 시 segment 추출 + 파싱
      if (collectBufferRef.current.includes(END_MARKER)) {
        const segment = extractCompletedSegment(collectBufferRef.current);
        if (segment) {
          try {
            const metrics = parseDiagnosticOutput(segment);
            setLatestDiagnostic(metrics);
            addEvent(
              "SYSTEM",
              `[${label}] 자료 일괄 수집 완료 — Dashboard 갱신`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            addEvent("SYSTEM", `[${label}] 진단 파싱 실패: ${msg}`);
          }
          // 종료 마커 이후로 buffer 트림 — 같은 segment를 다시 처리하지 않도록.
          const endIdx = collectBufferRef.current.lastIndexOf(END_MARKER);
          collectBufferRef.current = collectBufferRef.current.slice(
            endIdx + END_MARKER.length,
          );
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
  }, [role, localSessionId, addEvent, label, setLatestDiagnostic]);

  async function handleCollect() {
    if (!localSessionId) {
      addEvent("SYSTEM", `[${label}] 자료 일괄 수집 실패 — SSH 세션 비활성`);
      return;
    }
    let cmd: string;
    let svc: string;
    try {
      const cfg = await loadConfig();
      svc = cfg.monitoring.service_name.trim();
      if (svc === "") {
        addEvent(
          "SYSTEM",
          `[${label}] 자료 일괄 수집 실패 — 진단 서비스 이름 미설정 (설정 → 시스템 진단 탭).`,
        );
        return;
      }
      cmd = buildCollectCommand(svc, cfg.monitoring.collect_command);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[${label}] 자료 일괄 수집 실패 — 설정 로드 오류: ${msg}`);
      return;
    }
    try {
      await sshWrite(localSessionId, `${cmd}\n`);
      addEvent(
        "USER",
        `[${label}] 자료 일괄 수집 시작 (${svc}) — 완료 후 [분석 요청] 클릭`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[${label}] 자료 일괄 수집 실패: ${msg}`);
    }
  }

  async function handleCollect24hErrors() {
    if (!localSessionId) {
      addEvent("SYSTEM", `[${label}] 지난 24시간 오류 수집 실패 — SSH 세션 비활성`);
      return;
    }
    let cmd: string;
    let svc: string;
    try {
      const cfg = await loadConfig();
      svc = cfg.monitoring.service_name.trim();
      if (svc === "") {
        addEvent(
          "SYSTEM",
          `[${label}] 지난 24시간 오류 수집 실패 — 진단 서비스 이름 미설정 (설정 → 시스템 진단 탭).`,
        );
        return;
      }
      cmd = build24hErrorsCommand(svc);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent(
        "SYSTEM",
        `[${label}] 지난 24시간 오류 수집 실패 — 설정 로드 오류: ${msg}`,
      );
      return;
    }
    try {
      await sshWrite(localSessionId, `${cmd}\n`);
      addEvent(
        "USER",
        `[${label}] 지난 24시간 오류 수집 시작 (${svc}) — 완료 후 [분석 요청] 클릭`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[${label}] 지난 24시간 오류 수집 실패: ${msg}`);
    }
  }

  async function handleAnalyze() {
    if (!mainClaudeSessionId) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 실패 — 좌측 메인 Claude 세션 비활성.`,
      );
      return;
    }
    const api = sshApiRef.current;
    if (!api) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 실패 — 터미널 미초기화`,
      );
      return;
    }
    const allLines = api.readBufferLines();
    if (allLines.length === 0) {
      addEvent(
        "SYSTEM",
        `[${label}] 분석 요청 — 화면에 표시된 내용 없음 (clear 직후이거나 SSH 연결 직후)`,
      );
      return;
    }
    // 화면에 보이는 (xterm 버퍼) 내용 중 마지막 N줄로 cap.
    // clear 실행 시 viewport+scrollback 모두 지워지므로 그 이후 출력만 남음.
    const tail =
      allLines.length > ANALYZE_TAIL_LINES
        ? allLines.slice(-ANALYZE_TAIL_LINES)
        : allLines;
    const text = [
      `[${label} 패널 — 화면 마지막 ${tail.length}줄]`,
      ...tail,
    ].join("\n");
    // 사양서 §3.6 — 브라켓 페이스트 (자동 전송 X, 사용자가 검토 후 Enter)
    const wrapped = `\x1b[200~${text}\x1b[201~`;
    try {
      await ptyWrite(mainClaudeSessionId, wrapped);
      addEvent(
        "USER",
        `[${label}] Claude에 분석 요청 (${tail.length}줄 화면 내용 주입)`,
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
      <SshTerminal
        connect={conn.connect}
        onSessionChange={handleSessionChange}
        apiRef={sshApiRef}
        hideConnectingBanner={role === "diagnostic"}
      />
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
          {role === "diagnostic" && (
            <>
              <Button
                size="xs"
                onClick={handleCollect24hErrors}
                disabled={!localSessionId}
                className="[&_svg]:text-action-green"
                title={
                  !localSessionId
                    ? "SSH 세션 비활성"
                    : "지난 24시간의 ERROR/WARN/Exception/Caused by 로그를 journalctl로 수집 (시스템 메트릭/JVM 제외). 완료 후 [분석 요청]으로 Claude에 전달."
                }
              >
                <History /> 지난 24시간 오류
              </Button>
              <Button
                size="xs"
                onClick={handleCollect}
                disabled={!localSessionId}
                className="[&_svg]:text-action-green"
                title={
                  !localSessionId
                    ? "SSH 세션 비활성"
                    : "진단 대상 서비스의 진단 명령 일괄 실행 (uptime/df/top/journalctl/jstack 등). 완료 후 [분석 요청]으로 Claude에 전달."
                }
              >
                <ListChecks /> 자료 일괄 수집
              </Button>
            </>
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
