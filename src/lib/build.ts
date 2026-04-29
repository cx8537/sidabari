import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// 사양서 §3.2 [1] 빌드 단계.
// 백엔드 src-tauri/src/build.rs와 1:1 대응.

export type BuildOptions = {
  command: string;
  working_directory: string;
  timeout_seconds?: number;
};

export type LinePayload = {
  attempt_id: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type DonePayload = {
  attempt_id: string;
  exit_code: number | null;
  succeeded: boolean;
  reason: string;
};

export async function buildStart(opts: BuildOptions): Promise<string> {
  return await invoke<string>("build_start", { opts });
}

export async function buildKill(attemptId: string): Promise<void> {
  await invoke("build_kill", { attemptId });
}

export async function listenBuildLine(
  attemptId: string,
  handler: (payload: LinePayload) => void,
): Promise<UnlistenFn> {
  return await listen<LinePayload>(`build:line:${attemptId}`, (e) => {
    handler(e.payload);
  });
}

export async function listenBuildDone(
  attemptId: string,
  handler: (payload: DonePayload) => void,
): Promise<UnlistenFn> {
  return await listen<DonePayload>(`build:done:${attemptId}`, (e) => {
    handler(e.payload);
  });
}
