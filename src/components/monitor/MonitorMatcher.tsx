import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/useAppStore";
import { listenSshData } from "@/lib/ssh";
import { ptyWrite } from "@/lib/pty";
import { type Config, loadConfig } from "@/lib/config";
import { stripAnsi } from "@/lib/ansi";

// 사양서 §3.2 [4] / §3.6 시점 A — 메인 EC2 SSH stream에서 ERROR 패턴 자동 감지 →
// 직전 N줄 + 매칭 라인 + 직후 N줄(시간/라인 한도) + Caused by/stack 체인을 묶어
// 좌측 메인 Claude PTY 입력창에 브라켓 페이스트 모드로 자동 주입.
//
// UI 없음. App.tsx에 1회 마운트.

const STACK_LINE = /^\s+at /;
const CAUSED_BY = /^Caused by:/;
const SUPPRESSED = /^\s+Suppressed:/;
const STACK_MORE = /^\s+\.\.\. \d+ more/;

function isStackContinuation(line: string): boolean {
  return (
    STACK_LINE.test(line) ||
    CAUSED_BY.test(line) ||
    SUPPRESSED.test(line) ||
    STACK_MORE.test(line)
  );
}

type CaptureMode =
  | { kind: "waiting" }
  | {
      kind: "capturing";
      lines: string[];
      postCount: number;
      timer: number;
    };

export function MonitorMatcher() {
  const mainEc2 = useAppStore((s) => s.mainEc2SessionId);
  const mainClaude = useAppStore((s) => s.mainClaudeSessionId);
  const addEvent = useAppStore((s) => s.addEvent);

  // 항상 최신 mainClaudeSessionId/addEvent 참조
  const mainClaudeRef = useRef(mainClaude);
  mainClaudeRef.current = mainClaude;
  const addEventRef = useRef(addEvent);
  addEventRef.current = addEvent;

  useEffect(() => {
    if (!mainEc2) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // 매번 mount 시 설정 로드. 변경 사항은 다음 attempt 재시작 시 반영 (CLAUDE.md §1.3 정신).
    let cfg: Config | null = null;
    let lineBuffer = "";
    const ringBuffer: string[] = [];
    let mode: CaptureMode = { kind: "waiting" };
    let errorRegex: RegExp | null = null;

    function finalize() {
      if (mode.kind !== "capturing") return;
      const captured = mode.lines;
      window.clearTimeout(mode.timer);
      mode = { kind: "waiting" };
      if (captured.length === 0) return;

      const claudeId = mainClaudeRef.current;
      addEventRef.current(
        "MONITOR",
        `[ERROR 감지] ${captured.length}줄 컨텍스트 캡처${
          claudeId ? " → 좌측 Claude로 주입" : " (좌측 Claude 비활성 — 주입 생략)"
        }`,
      );

      if (claudeId) {
        const text = captured.join("\n");
        // 사양서 §3.6 — 브라켓 페이스트 (자동 전송 X, 사용자가 검토 후 Enter)
        const wrapped = `\x1b[200~${text}\x1b[201~`;
        ptyWrite(claudeId, wrapped).catch(() => {});
      }
    }

    function handleLine(line: string) {
      // ring buffer
      ringBuffer.push(line);
      const before = cfg?.monitoring.context_lines_before ?? 30;
      while (ringBuffer.length > before) ringBuffer.shift();

      if (mode.kind === "waiting") {
        if (errorRegex && errorRegex.test(line)) {
          const after = cfg?.monitoring.context_lines_after ?? 10;
          const delaySec = cfg?.monitoring.context_capture_delay_seconds ?? 5;
          const seed = [...ringBuffer]; // 직전 N + matched 자체
          const timer = window.setTimeout(finalize, Math.max(0, delaySec) * 1000);
          mode = { kind: "capturing", lines: seed, postCount: 0, timer };
          // matched 라인 자체는 이미 ringBuffer로 seed에 포함됨 — 중복 push X
          // 정확한 after 카운트 위해 postCount=0 유지
          void after; // (after는 push 시 체크)
        }
        return;
      }

      // capturing
      mode.lines.push(line);
      mode.postCount += 1;

      const after = cfg?.monitoring.context_lines_after ?? 10;
      const stackContinuing = isStackContinuation(line);

      if (mode.postCount >= after && !stackContinuing) {
        // 한도 도달 + stack 계속 아님 → 즉시 종료
        finalize();
      }
      // stack continuation이면 시간/라인 한도 무시하고 계속 누적 (사양서 §3.6 "Caused by 체인 + Suppressed")
    }

    function processChunk(chunk: string) {
      const stripped = stripAnsi(chunk);
      lineBuffer += stripped;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    }

    (async () => {
      try {
        cfg = await loadConfig();
      } catch {
        cfg = null;
      }
      const pat = cfg?.monitoring.error_pattern?.trim();
      if (!pat) {
        // 패턴 없으면 매칭 비활성 — 그래도 listen은 등록해 둠 (config 변경 후 재마운트 시 반영)
        errorRegex = null;
      } else {
        try {
          errorRegex = new RegExp(pat);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          addEventRef.current("SYSTEM", `error_pattern 정규식 오류: ${msg} — 모니터 매칭 비활성`);
          errorRegex = null;
        }
      }

      if (cancelled) return;
      unlisten = await listenSshData(mainEc2, (chunk) => {
        processChunk(chunk);
      });
    })().catch(() => {});

    return () => {
      cancelled = true;
      if (mode.kind === "capturing") {
        window.clearTimeout(mode.timer);
      }
      unlisten?.();
    };
  }, [mainEc2]);

  return null;
}
