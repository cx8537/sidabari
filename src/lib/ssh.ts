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

// SFTP — 사양서 §3.2 [2] jar 업로드.
export type SftpUploadOptions = {
  upload_id?: string;
  host: string;
  port?: number;
  user: string;
  private_key_path: string;
  local_path: string;
  remote_path: string;
};

// 사양서 §3.2 [2] — 업로드 무결성 보증. backend가 로컬 SHA256을 스트리밍 계산 +
// 원격 sha256sum exec으로 비교, 일치 시에만 성공 반환. 불일치는 sftpUpload가 reject.
export type SftpUploadResult = {
  bytes: number;
  sha256: string;
};

export async function sftpUpload(opts: SftpUploadOptions): Promise<SftpUploadResult> {
  return await invoke<SftpUploadResult>("sftp_upload", { opts });
}

export async function sftpUploadKill(uploadId: string): Promise<void> {
  await invoke("sftp_upload_kill", { uploadId });
}

// SFTP 업로드 진행률 — backend에서 200ms throttle로 emit (sftp.rs).
// bytes_total은 metadata 조회 실패 시 null. speed_bps는 시작 시점 누적 평균.
// phase는 단계 표시: "uploading" 전송 중, "verifying" 원격 sha256sum 대기 중.
export type SftpProgressPayload = {
  upload_id: string;
  phase: "uploading" | "verifying";
  bytes_done: number;
  bytes_total: number | null;
  speed_bps: number;
};

export async function listenSftpProgress(
  uploadId: string,
  handler: (payload: SftpProgressPayload) => void,
): Promise<UnlistenFn> {
  return await listen<SftpProgressPayload>(`sftp:progress:${uploadId}`, (e) => {
    handler(e.payload);
  });
}

// SSH exec — 사양서 §3.2 [3]/[4] (deploy.sh, monitor 등 단일 명령 + exit code).
export type SshExecOptions = {
  host: string;
  port?: number;
  user: string;
  private_key_path: string;
  command: string;
};

export type ExecLinePayload = {
  exec_id: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type ExecDonePayload = {
  exec_id: string;
  exit_code: number | null;
  succeeded: boolean;
  reason: string;
};

export async function sshExec(opts: SshExecOptions): Promise<string> {
  return await invoke<string>("ssh_exec", { opts });
}

export async function sshExecKill(execId: string): Promise<void> {
  await invoke("ssh_exec_kill", { execId });
}

export async function listenSshExecLine(
  execId: string,
  handler: (payload: ExecLinePayload) => void,
): Promise<UnlistenFn> {
  return await listen<ExecLinePayload>(`ssh-exec:line:${execId}`, (e) => {
    handler(e.payload);
  });
}

export async function listenSshExecDone(
  execId: string,
  handler: (payload: ExecDonePayload) => void,
): Promise<UnlistenFn> {
  return await listen<ExecDonePayload>(`ssh-exec:done:${execId}`, (e) => {
    handler(e.payload);
  });
}
