import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// 사양서 §3.2 / §4.2 / §1.2.3 — EC2 SSH 라이프사이클.
// 백엔드(src-tauri/src/ssh.rs)와 1:1 대응.

export type ConnectOptions = {
  session_id: string;
  host: string;
  port?: number;
  user: string;
  private_key_path: string;
  rows?: number;
  cols?: number;
};

export type DataPayload = {
  session_id: string;
  chunk: string;
};

export type ClosedPayload = {
  session_id: string;
  reason: string;
};

export type HostKeyPromptPayload = {
  request_id: string;
  host: string;
  port: number;
  fingerprint: string;
};

export async function sshConnect(opts: ConnectOptions): Promise<string> {
  return await invoke<string>("ssh_connect", { opts });
}

export async function sshWrite(sessionId: string, data: string): Promise<void> {
  await invoke("ssh_write", { sessionId, data });
}

export async function sshResize(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  await invoke("ssh_resize", { sessionId, rows, cols });
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  await invoke("ssh_disconnect", { sessionId });
}

export async function sshAcceptHostKey(
  requestId: string,
  accepted: boolean,
): Promise<void> {
  await invoke("ssh_accept_host_key", { requestId, accepted });
}

export async function listenSshData(
  sessionId: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return await listen<DataPayload>(`ssh:data:${sessionId}`, (e) => {
    handler(e.payload.chunk);
  });
}

export async function listenSshClosed(
  sessionId: string,
  handler: (reason: string) => void,
): Promise<UnlistenFn> {
  return await listen<ClosedPayload>(`ssh:closed:${sessionId}`, (e) => {
    handler(e.payload.reason);
  });
}

// 호스트 키 prompt — 글로벌 이벤트 (모든 connect에서 공통). App 전체에서 한 listener만 등록.
export async function listenSshHostKeyPrompt(
  handler: (payload: HostKeyPromptPayload) => void,
): Promise<UnlistenFn> {
  return await listen<HostKeyPromptPayload>("ssh:host-key-prompt", (e) => {
    handler(e.payload);
  });
}
