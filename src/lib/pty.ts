import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// 사양서 §3.1 / §4.2 — 좌측 메인 Claude / 중앙 상단 추가 Claude 탭들의 로컬 pty 라이프사이클.
// 백엔드(src-tauri/src/pty.rs)와 1:1 대응.

export type SpawnOptions = {
  // frontend에서 미리 생성한 session_id — listen 등록 후 spawn하기 위한 race 방지.
  session_id?: string;
  command: string;
  args?: string[];
  cwd?: string;
  rows?: number;
  cols?: number;
};

export type DataPayload = {
  session_id: string;
  chunk: string;
};

export type ExitPayload = {
  session_id: string;
  code: number | null;
};

export async function ptySpawn(opts: SpawnOptions): Promise<string> {
  return await invoke<string>("pty_spawn", { opts });
}

export async function ptyWrite(sessionId: string, data: string): Promise<void> {
  await invoke("pty_write", { sessionId, data });
}

export async function ptyResize(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  await invoke("pty_resize", { sessionId, rows, cols });
}

export async function ptyKill(sessionId: string): Promise<void> {
  await invoke("pty_kill", { sessionId });
}

export async function listenPtyData(
  sessionId: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return await listen<DataPayload>(`pty:data:${sessionId}`, (e) => {
    handler(e.payload.chunk);
  });
}

export async function listenPtyExit(
  sessionId: string,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return await listen<ExitPayload>(`pty:exit:${sessionId}`, (e) => {
    handler(e.payload.code);
  });
}
