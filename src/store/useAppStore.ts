import { create } from "zustand";

export type AttemptStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted";

export type PanelId =
  | "main-claude"
  | "claude-tabs"
  | "ec2-main"
  | "ec2-diagnostic"
  | "console";

export type ConsoleEvent = {
  id: string;
  timestamp: Date;
  source: string;
  message: string;
};

type AppState = {
  attemptStatus: AttemptStatus;
  attemptId: string | null;
  consoleEvents: ConsoleEvent[];
  focusedPanelId: PanelId | null;
  // 좌측 메인 Claude PTY의 현재 활성 sessionId (사양서 §3.6 — 분석 요청 텍스트 주입 대상).
  mainClaudeSessionId: string | null;
  // EC2 메인 SSH 활성 sessionId. 진단 패널이 mount되기 전 조건.
  mainEc2SessionId: string | null;
  // EC2 진단 SSH sessionId — 강제 중단 시 \x03 전송 대상.
  mainEc2DiagSessionId: string | null;
  // 현재 진행 중인 deploy ssh_exec id — 강제 중단 시 ssh_exec_kill 대상.
  activeDeployExecId: string | null;
  // 현재 진행 중인 SFTP upload id — 강제 중단 시 sftp_upload_kill 대상.
  activeUploadId: string | null;
  // EC2 진단 패널은 floating dialog로 표시 — 사용자가 [진단] 버튼으로 on-demand로 열고
  // 닫을 때 SSH 세션 자동 종료 (DialogContent unmount → SshTerminal cleanup).
  diagPanelOpen: boolean;
  addEvent: (source: string, message: string) => void;
  beginAttempt: (attemptId: string) => void;
  finishAttempt: (succeeded: boolean) => void;
  abortAttempt: () => void;
  resetAttempt: () => void;
  setFocusedPanel: (id: PanelId | null) => void;
  setMainClaudeSessionId: (id: string | null) => void;
  setMainEc2SessionId: (id: string | null) => void;
  setMainEc2DiagSessionId: (id: string | null) => void;
  setActiveDeployExecId: (id: string | null) => void;
  setActiveUploadId: (id: string | null) => void;
  setDiagPanelOpen: (open: boolean) => void;
};

function newEvent(source: string, message: string): ConsoleEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    source,
    message,
  };
}

export const useAppStore = create<AppState>((set) => ({
  attemptStatus: "idle",
  attemptId: null,
  consoleEvents: [newEvent("SYSTEM", "또돌이 시작")],
  focusedPanelId: null,
  mainClaudeSessionId: null,
  mainEc2SessionId: null,
  mainEc2DiagSessionId: null,
  activeDeployExecId: null,
  activeUploadId: null,
  diagPanelOpen: false,

  addEvent: (source, message) =>
    set((state) => ({
      consoleEvents: [...state.consoleEvents, newEvent(source, message)],
    })),

  beginAttempt: (attemptId) =>
    set((state) => ({
      attemptStatus: "running",
      attemptId,
      consoleEvents: [
        ...state.consoleEvents,
        newEvent("USER", `시도 시작 (id=${attemptId.slice(0, 8)})`),
      ],
    })),

  finishAttempt: (succeeded) =>
    set((state) => {
      if (state.attemptStatus !== "running") return state;
      return {
        attemptStatus: succeeded ? "succeeded" : "failed",
      };
    }),

  abortAttempt: () =>
    set((state) => {
      if (state.attemptStatus !== "running") return state;
      return {
        attemptStatus: "aborted",
        consoleEvents: [
          ...state.consoleEvents,
          newEvent("USER", "강제 중단 클릭 (Ctrl+C 전송, SSH 채널 유지)"),
        ],
      };
    }),

  resetAttempt: () =>
    set({
      attemptStatus: "idle",
      attemptId: null,
    }),

  setFocusedPanel: (id) => set({ focusedPanelId: id }),

  setMainClaudeSessionId: (id) => set({ mainClaudeSessionId: id }),

  setMainEc2SessionId: (id) => set({ mainEc2SessionId: id }),

  setMainEc2DiagSessionId: (id) => set({ mainEc2DiagSessionId: id }),

  setActiveDeployExecId: (id) => set({ activeDeployExecId: id }),

  setActiveUploadId: (id) => set({ activeUploadId: id }),

  setDiagPanelOpen: (open) => set({ diagPanelOpen: open }),
}));
