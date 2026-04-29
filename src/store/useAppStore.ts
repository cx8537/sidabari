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
  addEvent: (source: string, message: string) => void;
  beginAttempt: (attemptId: string) => void;
  finishAttempt: (succeeded: boolean) => void;
  abortAttempt: () => void;
  resetAttempt: () => void;
  setFocusedPanel: (id: PanelId | null) => void;
  setMainClaudeSessionId: (id: string | null) => void;
  setMainEc2SessionId: (id: string | null) => void;
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
}));
