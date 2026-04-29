import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEME } from "./Terminal";
import { Button } from "@/components/ui/button";
import {
  listenSshClosed,
  listenSshData,
  sshConnect,
  sshDisconnect,
  sshResize,
  sshWrite,
  type ConnectOptions,
} from "@/lib/ssh";

// SSH 연결 정보 — session_id, rows, cols는 SshTerminal이 채움.
export type SshConnect = Omit<ConnectOptions, "session_id" | "rows" | "cols">;

type Props = {
  connect: SshConnect | null; // null이면 "설정 필요" 표시
  onSessionChange?: (sessionId: string | null) => void;
};

type Status = "idle" | "connecting" | "running" | "closed" | "error";

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

export function SshTerminal({ connect, onSessionChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenClosedRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function notifySession(id: string | null) {
    sessionIdRef.current = id;
    onSessionChangeRef.current?.(id);
  }

  async function startSsh() {
    const term = termRef.current;
    if (!term || disposedRef.current || !connect) return;

    unlistenDataRef.current?.();
    unlistenClosedRef.current?.();
    unlistenDataRef.current = null;
    unlistenClosedRef.current = null;
    notifySession(null);
    setErrorMsg(null);
    setStatus("connecting");
    term.writeln(
      `\x1b[90m[연결 중: ${connect.user}@${connect.host}:${connect.port ?? 22}]\x1b[0m`,
    );

    const preId = crypto.randomUUID();
    try {
      unlistenDataRef.current = await listenSshData(preId, (chunk) => {
        // alt-screen TUI(top, vim 등)와 충돌 방지를 위해 alt 활성/진입 시 보강 생략.
        const hasClear = chunk.indexOf("\x1b[2J") >= 0;
        const enteringAlt =
          chunk.indexOf("\x1b[?1049h") >= 0 || chunk.indexOf("\x1b[?47h") >= 0;
        const inAlt = term.buffer.active.type === "alternate";
        const shouldAugment = hasClear && !enteringAlt && !inAlt;
        const augmented = shouldAugment
          ? chunk.replace(/\x1b\[2J/g, "\x1b[2J\x1b[3J")
          : chunk;
        term.write(augmented, () => {
          if (shouldAugment) term.refresh(0, term.rows - 1);
        });
      });
      unlistenClosedRef.current = await listenSshClosed(preId, (reason) => {
        notifySession(null);
        setStatus("closed");
        term.writeln("");
        term.writeln(`\x1b[90m[연결 종료: ${reason}]\x1b[0m`);
      });

      if (disposedRef.current) {
        unlistenDataRef.current?.();
        unlistenClosedRef.current?.();
        return;
      }

      const id = await sshConnect({
        ...connect,
        session_id: preId,
        rows: term.rows,
        cols: term.cols,
      });
      if (disposedRef.current) {
        await sshDisconnect(id).catch(() => {});
        return;
      }
      notifySession(id);
      setStatus("running");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus("error");
      setErrorMsg(msg);
      term.writeln(`\x1b[31m[SSH 연결 실패: ${msg}]\x1b[0m`);
    }
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
      // ignore
    }

    attachKeyShortcuts(term);

    term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) sshWrite(id, data).catch(() => {});
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
      if (id) sshResize(id, term.rows, term.cols).catch(() => {});
    });
    resizeObserver.observe(container);

    if (connect) {
      void startSsh();
    } else {
      term.writeln(
        `\x1b[90m[설정에 EC2 host / user / 개인키 경로가 누락 — 설정 모달에서 입력 후 재시작]\x1b[0m`,
      );
      setStatus("idle");
    }

    return () => {
      disposedRef.current = true;
      resizeObserver.disconnect();
      unlistenDataRef.current?.();
      unlistenClosedRef.current?.();
      if (sessionIdRef.current) {
        sshDisconnect(sessionIdRef.current).catch(() => {});
      }
      notifySession(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showReconnect =
    connect !== null && (status === "closed" || status === "error");

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
      {showReconnect && (
        <div className="absolute right-2 top-2 flex items-center gap-2 rounded-md bg-card/90 px-2 py-1 ring-1 ring-foreground/10 backdrop-blur-sm">
          {status === "error" && errorMsg && (
            <span className="text-xs text-destructive">SSH 오류: {errorMsg}</span>
          )}
          {status === "closed" && (
            <span className="text-xs text-muted-foreground">연결 종료</span>
          )}
          <Button size="xs" variant="outline" onClick={() => void startSsh()}>
            재연결
          </Button>
        </div>
      )}
    </div>
  );
}
