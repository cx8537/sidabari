import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEME } from "./Terminal";
import { Button } from "@/components/ui/button";
import {
  listenPtyData,
  listenPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type SpawnOptions,
} from "@/lib/pty";

type Props = {
  spawn: SpawnOptions;
  onExit?: (code: number | null) => void;
  // 활성 PTY 세션 ID 변경 알림 — 폴백 셸 전환/재시작/언마운트 시 호출.
  // 외부(store 등)가 ptyWrite 대상으로 사용 (사양서 §3.6 분석 요청 텍스트 주입).
  onSessionChange?: (sessionId: string | null) => void;
};

type Status = "starting" | "running" | "exited-fallback" | "stopped" | "error";

// Ctrl+C: 선택 영역 있으면 클립보드 복사(차단), 없으면 \x03 → PTY (사양서 §3.7).
// Ctrl+A: 전체 선택 (readline의 \x01이 PTY로 가지 않게 차단).
function attachKeyShortcuts(term: XTerminal) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    if (!mod) return true;
    if (e.key === "c") {
      const selection = term.getSelection();
      if (selection && selection.length > 0) {
        writeText(selection).catch(() => {});
        return false;
      }
      return true;
    }
    if (e.key === "a") {
      term.selectAll();
      return false;
    }
    return true;
  });
}

export function PtyTerminal({ spawn, onExit, onSessionChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  // primary: props.spawn 명령. fallback: claude 등 종료 후 OS 기본 셸. final: 더 이상 자동 폴백 없음.
  const phaseRef = useRef<"primary" | "fallback" | "final">("primary");
  const disposedRef = useRef(false);
  // prop을 ref로 wrap — useCallback/useEffect deps 흔들지 않으면서 최신 prop 호출.
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const [status, setStatus] = useState<Status>("starting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function notifySession(id: string | null) {
    sessionIdRef.current = id;
    onSessionChangeRef.current?.(id);
  }

  // 사양서 §1.3 / §5.1 — 자동 재시도는 금지지만 명령 종료 후 셸 폴백은 다른 영역(다음 작업을 위한 환경 유지).
  // 셸도 종료되면 [다시 시작] 버튼으로 사용자 명시 액션 요구.
  const startPty = useCallback(
    async (opts: SpawnOptions, isFallback = false) => {
      const term = termRef.current;
      if (!term || disposedRef.current) return;

      // 이전 listen 해제 (재spawn 시 중복 방지)
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      unlistenDataRef.current = null;
      unlistenExitRef.current = null;
      notifySession(null);
      setStatus("starting");

      const preId = crypto.randomUUID();

      try {
        unlistenDataRef.current = await listenPtyData(preId, (chunk) => {
          // cmd.exe `cls`는 \x1b[2J\x1b[H만 보내 xterm scrollback이 남고,
          // renderer 셀 캐시도 stale 상태로 남아 잔상이 보임.
          // 직후 \x1b[3J(saved-lines erase)을 주입해 buffer를 깨끗이 + write callback에서
          // term.refresh로 강제 viewport redraw. alt-screen TUI는 alt buffer 사용으로 영향 없음.
          const hasClear = chunk.indexOf("\x1b[2J") >= 0;
          const augmented = hasClear
            ? chunk.replace(/\x1b\[2J/g, "\x1b[2J\x1b[3J")
            : chunk;
          term.write(augmented, () => {
            if (hasClear) {
              term.refresh(0, term.rows - 1);
            }
          });
        });
        unlistenExitRef.current = await listenPtyExit(preId, (code) => {
          handleExit(code);
        });

        if (disposedRef.current) {
          unlistenDataRef.current?.();
          unlistenExitRef.current?.();
          return;
        }

        const id = await ptySpawn({
          ...opts,
          session_id: preId,
          rows: term.rows,
          cols: term.cols,
        });
        if (disposedRef.current) {
          await ptyKill(id).catch(() => {});
          return;
        }
        notifySession(id);
        setStatus("running");
        if (isFallback) {
          term.writeln(`\x1b[90m[기본 셸로 전환]\x1b[0m`);
        }
      } catch (e) {
        if (disposedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setErrorMsg(msg);
        term.writeln(`\x1b[31m[pty 시작 실패: ${msg}]\x1b[0m`);
        phaseRef.current = "final";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function handleExit(code: number | null) {
    const term = termRef.current;
    onExitRef.current?.(code);

    notifySession(null);
    if (!term || disposedRef.current) return;

    term.writeln("");
    term.writeln(`\x1b[90m[프로세스 종료, exit code = ${code ?? "?"}]\x1b[0m`);

    // 폴백 정책: primary가 명시 명령(claude 등)이었으면 OS 기본 셸로 전환.
    // primary가 처음부터 OS 셸이었거나 이미 fallback 단계면 더 자동 spawn 안 함.
    const phase = phaseRef.current;
    const primaryWasShell = !spawn.command || spawn.command.trim() === "";
    if (phase === "primary" && !primaryWasShell) {
      phaseRef.current = "fallback";
      setStatus("exited-fallback");
      void startPty({ command: "", cwd: spawn.cwd }, true);
    } else {
      phaseRef.current = "final";
      setStatus("stopped");
    }
  }

  function handleRestart() {
    if (disposedRef.current) return;
    phaseRef.current = "primary";
    setErrorMsg(null);
    void startPty(spawn);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const term = new XTerminal({
      theme: TERMINAL_THEME,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "D2Coding", "Malgun Gothic", monospace',
      fontSize: 14,
      fontWeight: "300",
      fontWeightBold: "500",
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false,
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(container);

    try {
      fit.fit();
    } catch {
      // 컨테이너 크기 미정인 경우 무시
    }

    attachKeyShortcuts(term);

    // onData listener는 한 번만 등록. sessionId 변경은 ref로.
    term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) ptyWrite(id, data).catch(() => {});
    });

    termRef.current = term;
    fitRef.current = fit;

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = sessionIdRef.current;
      if (id) {
        ptyResize(id, term.rows, term.cols).catch(() => {});
      }
    });
    resizeObserver.observe(container);

    // 첫 spawn — primary
    phaseRef.current = "primary";
    void startPty(spawn);

    return () => {
      disposedRef.current = true;
      resizeObserver.disconnect();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      if (sessionIdRef.current) {
        ptyKill(sessionIdRef.current).catch(() => {});
      }
      notifySession(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showRestart = status === "stopped" || status === "error";

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
      {showRestart && (
        <div className="absolute right-2 top-2 flex items-center gap-2 rounded-md bg-card/90 px-2 py-1 ring-1 ring-foreground/10 backdrop-blur-sm">
          {status === "error" && errorMsg && (
            <span className="text-xs text-destructive">PTY 오류: {errorMsg}</span>
          )}
          {status === "stopped" && (
            <span className="text-xs text-muted-foreground">세션 종료</span>
          )}
          <Button size="xs" variant="outline" onClick={handleRestart}>
            다시 시작
          </Button>
        </div>
      )}
    </div>
  );
}
