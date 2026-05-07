import { create } from "zustand";
import type { DiagnosticMetrics } from "@/lib/parseDiagnostic";

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

// Phase 1 — 패널별 Claude turn 활성 상태. key는 SIDABARI_PANEL_ID (예: "main-claude", "claude-tab:<uuid>").
// SessionStart/Pre/PostToolUse → "thinking", Stop/SubagentStop → "idle".
export type PanelActivityState = "thinking" | "idle";
export type PanelActivity = {
  state: PanelActivityState;
  /** Date.now() — "thinking 시작" 또는 "idle 진입" 시각. */
  since: number;
};

// Phase 3 — 진행 중 도구 가시화. PreToolUse 시 set, Stop 시 clear (PostToolUse는 다음 set까지 유지 — 깜박임 방지).
export type PanelCurrentTool = {
  /** 도구명 (Bash, Edit, Write 등) */
  tool: string;
  /** 사용자 가시 요약 (명령 일부, 파일 경로 등) */
  detail: string;
  since: number;
};

type AppState = {
  attemptStatus: AttemptStatus;
  attemptId: string | null;
  consoleEvents: ConsoleEvent[];
  focusedPanelId: PanelId | null;
  panelActivity: Record<string, PanelActivity>;
  panelCurrentTool: Record<string, PanelCurrentTool>;
  /// 모든 Claude PTY를 일괄 unmount/remount하기 위한 카운터.
  /// MainClaudePanel/ClaudeTabsPanel의 PtyTerminal key prop에 결합되어, 값이 바뀌면
  /// React가 컴포넌트를 새로 mount → 새 spawn → 새 settings.local.json 로드.
  claudeRestartKey: number;
  /// EC2 SSH 패널 출력에서 host(IP) 마스킹 활성 여부. SettingsModal save 시 갱신,
  /// SshTerminal이 mount 시 loadConfig로 한 번 더 동기화. 토글 즉시 반영 (새 chunk부터).
  maskEc2Ips: boolean;
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
  // Dashboard 헤드리스 새로고침 진행 중인 ssh_collect_exec id — 강제 중단 시 ssh_collect_kill 대상.
  // 진단 패널 SSH 세션과는 별개 (헤드리스, 화면 X). 동시에 1개만 실행 (UI에서 가드).
  activeDiagExecId: string | null;
  // EC2 진단 패널은 floating dialog로 표시 — 사용자가 [진단] 버튼으로 on-demand로 열고
  // 닫을 때 SSH 세션 자동 종료 (DialogContent unmount → SshTerminal cleanup).
  diagPanelOpen: boolean;
  // 자료 일괄 수집 결과 — Dashboard 탭이 구독해 카드로 표시.
  // 새 수집이 완료될 때마다 EC2 진단 패널 측 listener가 갱신.
  latestDiagnostic: DiagnosticMetrics | null;
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
  setActiveDiagExecId: (id: string | null) => void;
  setDiagPanelOpen: (open: boolean) => void;
  setLatestDiagnostic: (m: DiagnosticMetrics | null) => void;
  setPanelActivity: (panelId: string, state: PanelActivityState) => void;
  setPanelCurrentTool: (panelId: string, tool: string, detail: string) => void;
  clearPanelCurrentTool: (panelId: string) => void;
  /** 모든 Claude PTY 일괄 재시작 (settings.local.json 변경 즉시 반영). */
  restartAllClaudes: () => void;
  setMaskEc2Ips: (v: boolean) => void;
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
  consoleEvents: [newEvent("SYSTEM", "Sidabari 시작")],
  focusedPanelId: null,
  mainClaudeSessionId: null,
  mainEc2SessionId: null,
  mainEc2DiagSessionId: null,
  activeDeployExecId: null,
  activeUploadId: null,
  activeDiagExecId: null,
  diagPanelOpen: false,
  latestDiagnostic: null,
  panelActivity: {},
  panelCurrentTool: {},
  claudeRestartKey: 0,
  maskEc2Ips: false,

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

  setActiveDiagExecId: (id) => set({ activeDiagExecId: id }),

  setDiagPanelOpen: (open) => set({ diagPanelOpen: open }),

  setLatestDiagnostic: (latestDiagnostic) => set({ latestDiagnostic }),

  setPanelActivity: (panelId, state) =>
    set((prev) => {
      const cur = prev.panelActivity[panelId];
      // 같은 state 유지 시 since 갱신 X — 초 카운터가 흔들리지 않도록.
      if (cur && cur.state === state) return prev;
      return {
        panelActivity: {
          ...prev.panelActivity,
          [panelId]: { state, since: Date.now() },
        },
      };
    }),

  setPanelCurrentTool: (panelId, tool, detail) =>
    set((prev) => ({
      panelCurrentTool: {
        ...prev.panelCurrentTool,
        [panelId]: { tool, detail, since: Date.now() },
      },
    })),

  clearPanelCurrentTool: (panelId) =>
    set((prev) => {
      if (!prev.panelCurrentTool[panelId]) return prev;
      const next = { ...prev.panelCurrentTool };
      delete next[panelId];
      return { panelCurrentTool: next };
    }),

  restartAllClaudes: () =>
    set((prev) => ({
      claudeRestartKey: prev.claudeRestartKey + 1,
      consoleEvents: [
        ...prev.consoleEvents,
        newEvent("USER", "Claude PTY 일괄 재시작 (설정 변경 반영)"),
      ],
    })),

  setMaskEc2Ips: (v) => set({ maskEc2Ips: v }),
}));
