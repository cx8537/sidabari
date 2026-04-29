// ANSI escape sequences (CSI) 제거 — 라인 매칭이나 컨텍스트 캡처 시 색상/cursor 코드 영향 제외.
const ANSI_CSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "");
}
