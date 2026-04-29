import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

const TERMINAL_THEME = {
  background: "#191A1C",
  foreground: "#CCCED3",
  cursor: "#CCCED3",
  cursorAccent: "#191A1C",
  selectionBackground: "#3A5378",
  black: "#191A1C",
  red: "#E06C75",
  green: "#508956",
  yellow: "#B28B55",
  blue: "#35538F",
  magenta: "#C678DD",
  cyan: "#56B6C2",
  white: "#CCCED3",
  brightBlack: "#5C6370",
  brightRed: "#E06C75",
  brightGreen: "#98C379",
  brightYellow: "#D8A671",
  brightBlue: "#61AFEF",
  brightMagenta: "#C678DD",
  brightCyan: "#56B6C2",
  brightWhite: "#E4E6EA",
};

type Props = {
  initialLines?: string[];
};

export function Terminal({ initialLines }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
      convertEol: true,
      scrollback: 5000,
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
      // Container may not have dimensions yet
    }

    if (initialLines) {
      for (const line of initialLines) {
        term.writeln(line);
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
