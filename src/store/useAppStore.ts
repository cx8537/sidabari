import { create } from "zustand";

export type AttemptStatus = "idle" | "running" | "aborted";

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
  consoleEvents: ConsoleEvent[];
  focusedPanelId: PanelId | null;
  addEvent: (source: string, message: string) => void;
  startAttempt: () => void;
  abortAttempt: () => void;
  setFocusedPanel: (id: PanelId | null) => void;
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
  consoleEvents: [newEvent("SYSTEM", "또돌이 시작 (1단계 UI Mock)")],
  focusedPanelId: null,

  addEvent: (source, message) =>
    set((state) => ({
      consoleEvents: [...state.consoleEvents, newEvent(source, message)],
    })),

  startAttempt: () =>
    set((state) => {
      if (state.attemptStatus === "running") return state;
      return {
        attemptStatus: "running",
        consoleEvents: [
          ...state.consoleEvents,
          newEvent("USER", "시도 시작 클릭"),
        ],
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

  setFocusedPanel: (id) => set({ focusedPanelId: id }),
}));
