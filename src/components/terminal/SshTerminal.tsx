import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
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
import { useAppStore } from "@/store/useAppStore";
import { loadConfig } from "@/lib/config";

// 옵션 A 마스킹 — config.ec2.host 정확 매칭만 치환. false positive 없음.
// "***REDACTED-IP***" → "*.***.***.244" / "example.com" → "ex***om".
function maskHost(host: string): string {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) return `*.***.***.${ipv4[4]}`;
  if (host.length <= 4) return "***";
  return `${host.slice(0, 2)}***${host.slice(-2)}`;
}

/// stream chunk masker — chunk 경계에 host가 걸쳐도 처리.
/// 끝부분이 host의 prefix일 가능성이 있으면 buffer로 보관해 다음 chunk와 합쳐 매칭.
function makeStreamMasker(host: string) {
  const masked = maskHost(host);
  let buffer = "";
  return (chunk: string): string => {
    if (!host) return chunk;
    const combined = buffer + chunk;
    const replaced = combined.split(host).join(masked);
    const maxOverlap = Math.min(host.length - 1, replaced.length);
    let overlap = 0;
    for (let len = maxOverlap; len > 0; len--) {
      if (host.startsWith(replaced.slice(-len))) {
        overlap = len;
        break;
      }
    }
    if (overlap > 0) {
      buffer = replaced.slice(-overlap);
      return replaced.slice(0, -overlap);
    }
    buffer = "";
    return replaced;
  };
}

// SSH 연결 정보 — session_id, rows, cols는 SshTerminal이 채움.
export type SshConnect = Omit<ConnectOptions, "session_id" | "rows" | "cols">;

// 외부(예: EC2Panel handleAnalyze)에서 터미널 버퍼 내용을 읽을 때 쓰는 API.
// xterm 본인의 buffer를 그대로 읽으므로 clear(\x1b[2J + \x1b[3J) 이후엔 자연스럽게 비어있음.
export type SshTerminalApi = {
  // 현재 xterm 버퍼(viewport + scrollback)의 모든 라인을 텍스트로. trailing 공백 줄은 제거.
  readBufferLines(): string[];
};

type Props = {
  connect: SshConnect | null; // null이면 "설정 필요" 표시
  onSessionChange?: (sessionId: string | null) => void;
  apiRef?: React.MutableRefObject<SshTerminalApi | null>;
  // true면 연결 직후 "[연결 중: user@host:port]" 헤더 라인을 출력하지 않음.
  // 진단 플로팅 패널처럼 화면 캡처/녹화 시 IP 노출을 줄이고 싶을 때 사용.
  // 에러 / 연결 종료 메시지는 영향 받지 않음.
  hideConnectingBanner?: boolean;
};

type Status = "idle" | "connecting" | "running" | "closed" | "error";

// Ctrl+V는 xterm 기본 처리가 raw \x16(SYN)을 SSH로 보냄 — paste가 아님.
// 클립보드를 읽어 term.paste()로 라우팅해 Ctrl+Shift+V와 같은 paste 경로(브래킷 페이스트 모드 존중) 사용.
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
    if (e.key === "v") {
      readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
      return false;
    }
    if (e.key === "a") {
      term.selectAll();
      return false;
    }
    return true;
  });
}

export function SshTerminal({
  connect,
  onSessionChange,
  apiRef,
  hideConnectingBanner,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenClosedRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  // 마스킹 토글 — store 구독 + ref로 콜백에서 최신값 참조 (deps 흔들지 않음).
  const maskEc2Ips = useAppStore((s) => s.maskEc2Ips);
  const setMaskEc2Ips = useAppStore((s) => s.setMaskEc2Ips);
  const maskRef = useRef(maskEc2Ips);
  maskRef.current = maskEc2Ips;

  // mount 시 loadConfig로 store 동기화 (앱 시작 직후 첫 SshTerminal이 store 초기화 담당).
  // 기존 store가 이미 SettingsModal save로 갱신되어 있으면 동일 값 재기록 — 무해.
  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        setMaskEc2Ips(c.ui.mask_ec2_ips ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setMaskEc2Ips]);

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
    // 마스킹 — 새 SSH 세션마다 새 stream masker. 토글 ON일 때만 실제 transform 적용 (maskRef).
    const masker = makeStreamMasker(connect.host);
    if (!hideConnectingBanner) {
      const hostBanner = maskRef.current
        ? maskHost(connect.host)
        : connect.host;
      term.writeln(
        `\x1b[90m[연결 중: ${connect.user}@${hostBanner}:${connect.port ?? 22}]\x1b[0m`,
      );
    }

    const preId = crypto.randomUUID();
    try {
      unlistenDataRef.current = await listenSshData(preId, (rawChunk) => {
        const chunk = maskRef.current ? masker(rawChunk) : rawChunk;
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
      // Win11 우선 — Cascadia Mono(터미널 기본)를 첫 자리에. App.css `--font-mono`와 동일.
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", ui-monospace, Consolas, "SF Mono", Menlo, "Liberation Mono", monospace',
      fontSize: 14,
      fontWeight: "300",
      fontWeightBold: "500",
      lineHeight: 1.3,
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

    // 외부 노출 API — term 버퍼 직접 읽기. ring buffer 대체.
    if (apiRef) {
      apiRef.current = {
        readBufferLines() {
          const buf = term.buffer.active;
          const out: string[] = [];
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) out.push(line.translateToString(true));
          }
          while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
          return out;
        },
      };
    }

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
      if (apiRef) apiRef.current = null;
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
