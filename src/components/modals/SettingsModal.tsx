import { useEffect, useState } from "react";
import {
  Bell,
  Eye,
  EyeOff,
  FolderOpen,
  ShieldCheck,
  Settings as SettingsIcon,
  Server,
  Hammer,
  AlertCircle,
  Stethoscope,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { type Config, ConfigSchema, loadConfig, saveConfig } from "@/lib/config";
import {
  claudeSafetyRulesStatus,
  installClaudeSafetyRules,
} from "@/lib/claudeSafety";
import { installClaudeHooks } from "@/lib/claudeHooks";
import {
  installDiagSshAllow,
  removeDiagSshAllow,
} from "@/lib/diagSshAllow";
import { DiagSetupModal } from "@/components/modals/DiagSetupModal";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; config: Config }
  | { status: "error"; message: string };

type TabId = "general" | "server" | "deploy" | "monitor" | "diagnostic";

const TABS: ReadonlyArray<{
  id: TabId;
  label: string;
  Icon: typeof SettingsIcon;
}> = [
  { id: "general", label: "일반", Icon: SettingsIcon },
  { id: "server", label: "서버 (SSH/SFTP)", Icon: Server },
  { id: "deploy", label: "빌드/배포", Icon: Hammer },
  { id: "monitor", label: "모니터링", Icon: AlertCircle },
  { id: "diagnostic", label: "시스템 진단", Icon: Stethoscope },
];

const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  schema_version: 1,
  display_name: "Sidabari",
  project: { name: "" },
  claude_code_sessions: {
    main: { label: "", directory: "", auto_start: false },
    additional: [],
  },
  ec2: {
    host: "",
    port: 22,
    user: "ubuntu",
    private_key_path: "",
    diag_private_key_path: "",
  },
  sftp: { use_same_as_ssh: true, remote_upload_path: "" },
  deploy: {
    build_command: "",
    build_working_directory: "",
    jar_output_path: "",
    build_timeout_seconds: 300,
    deploy_script: "",
    restart_script: "",
    stop_script: "",
  },
  monitoring: {
    service_name: "",
    collect_command: "",
    log_command: "",
    error_pattern: "\\[ERROR\\]",
    context_lines_before: 30,
    context_lines_after: 10,
    context_capture_delay_seconds: 5,
  },
  safety: { ssh_disconnect_grace_seconds: 10 },
  ui: {
    verbose_hook_logs: false,
    gate_dangerous_tools: false,
    auto_restart_claude_after_settings_change: false,
    mask_ec2_ips: false,
  },
});

const INPUT_CLASS =
  "h-8 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50";

const TEXTAREA_CLASS =
  "min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground disabled:opacity-50";

export function SettingsModal({ open, onOpenChange }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const restartAllClaudes = useAppStore((s) => s.restartAllClaudes);
  const setMaskEc2Ips = useAppStore((s) => s.setMaskEc2Ips);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showHost, setShowHost] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showDiagKey, setShowDiagKey] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [safetyInstalling, setSafetyInstalling] = useState(false);
  const [safetyMessage, setSafetyMessage] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | { kind: "info"; text: string }
    | null
  >(null);
  const [hookInstalling, setHookInstalling] = useState(false);
  const [hookMessage, setHookMessage] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | { kind: "info"; text: string }
    | null
  >(null);
  const [diagSetupOpen, setDiagSetupOpen] = useState(false);
  const [diagAllowBusy, setDiagAllowBusy] = useState(false);
  const [diagAllowMessage, setDiagAllowMessage] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | { kind: "info"; text: string }
    | null
  >(null);
  const [activeTab, setActiveTab] = useState<TabId>("general");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    setSaveError(null);
    setPickError(null);
    setShowHost(false);
    setShowKey(false);
    setShowDiagKey(false);
    setSafetyMessage(null);
    setActiveTab("general");
    loadConfig()
      .then((config) => {
        if (cancelled) return;
        setState({ status: "ready", config });
        const dir = config.claude_code_sessions.main.directory;
        if (dir.trim() !== "") {
          claudeSafetyRulesStatus(dir)
            .then((report) => {
              if (cancelled) return;
              if (report) {
                setSafetyMessage({
                  kind: "info",
                  text: `이미 설치됨: deny ${report.deny_count}개 (${report.installed_path})`,
                });
              }
            })
            .catch(() => {});
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const config = state.status === "ready" ? state.config : DEFAULT_CONFIG;
  const isReady = state.status === "ready";

  function updateEc2(patch: Partial<Config["ec2"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: { ...state.config, ec2: { ...state.config.ec2, ...patch } },
    });
  }

  function updateMainSession(patch: Partial<Config["claude_code_sessions"]["main"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: {
        ...state.config,
        claude_code_sessions: {
          ...state.config.claude_code_sessions,
          main: { ...state.config.claude_code_sessions.main, ...patch },
        },
      },
    });
  }

  function updateDeploy(patch: Partial<Config["deploy"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: { ...state.config, deploy: { ...state.config.deploy, ...patch } },
    });
  }

  function updateSftp(patch: Partial<Config["sftp"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: { ...state.config, sftp: { ...state.config.sftp, ...patch } },
    });
  }

  function updateMonitoring(patch: Partial<Config["monitoring"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: {
        ...state.config,
        monitoring: { ...state.config.monitoring, ...patch },
      },
    });
  }

  function updateUi(patch: Partial<Config["ui"]>) {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      config: { ...state.config, ui: { ...state.config.ui, ...patch } },
    });
  }

  async function handleInstallHooks() {
    if (state.status !== "ready") return;
    const sessions = state.config.claude_code_sessions;
    const dirs = [sessions.main.directory, ...sessions.additional.map((s) => s.directory)]
      .map((d) => d.trim())
      .filter((d) => d !== "");
    if (dirs.length === 0) {
      setHookMessage({
        kind: "err",
        text: "Claude 작업 디렉토리(메인/추가)를 먼저 설정하세요",
      });
      return;
    }
    const enableGate = state.config.ui.gate_dangerous_tools;
    setHookInstalling(true);
    setHookMessage(null);
    try {
      const reports = [];
      for (const dir of dirs) {
        const r = await installClaudeHooks(dir, enableGate);
        reports.push({ dir, r });
      }
      const totalAdded = reports.reduce((s, x) => s + x.r.events_added.length, 0);
      const created = reports.filter((x) => x.r.created).length;
      const gateNote = enableGate ? " · Bash 게이트 활성" : "";
      setHookMessage({
        kind: "ok",
        text: `${reports.length}개 디렉토리 처리 — 신규 생성 ${created}개, 이벤트 ${totalAdded}개 추가${gateNote}`,
      });
      addEvent(
        "USER",
        `Claude 훅 설치 — ${reports.length}개 디렉토리 (이벤트 ${totalAdded}${gateNote})`,
      );
      if (state.config.ui.auto_restart_claude_after_settings_change) {
        restartAllClaudes();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHookMessage({ kind: "err", text: msg });
    } finally {
      setHookInstalling(false);
    }
  }

  async function handleSave() {
    if (state.status !== "ready") return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveConfig(state.config);
      // store에도 즉시 반영해 SshTerminal 등 구독자가 다음 chunk부터 적용.
      setMaskEc2Ips(state.config.ui.mask_ec2_ips);
      addEvent("SYSTEM", "설정 저장 완료");
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePickKey() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "개인키 (.pem) 선택",
        filters: [
          { name: "PEM Key", extensions: ["pem"] },
          { name: "모든 파일", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string") {
        updateEc2({ private_key_path: selected });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPickError(message);
    }
  }

  async function handlePickDiagKey() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "진단 전용 키 (ForceCommand로 잠긴 키) 선택",
        filters: [
          { name: "PEM/Key", extensions: ["pem", "key"] },
          { name: "모든 파일", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string") {
        updateEc2({ diag_private_key_path: selected });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPickError(message);
    }
  }

  async function handleInstallDiagAllow() {
    if (state.status !== "ready") return;
    const sessions = state.config.claude_code_sessions;
    const dirs = [sessions.main.directory, ...sessions.additional.map((s) => s.directory)]
      .map((d) => d.trim())
      .filter((d) => d !== "");
    const host = state.config.ec2.host.trim();
    const user = state.config.ec2.user.trim();
    if (dirs.length === 0) {
      setDiagAllowMessage({
        kind: "err",
        text: "Claude 작업 디렉토리(메인/추가)를 먼저 설정하세요",
      });
      return;
    }
    if (host === "" || user === "") {
      setDiagAllowMessage({
        kind: "err",
        text: "EC2 host / user를 먼저 설정하세요 ([서버] 탭)",
      });
      return;
    }
    setDiagAllowBusy(true);
    setDiagAllowMessage(null);
    try {
      const reports = [];
      for (const dir of dirs) {
        reports.push(await installDiagSshAllow(dir, host, user));
      }
      const patternCount = reports[0]?.patterns.length ?? 0;
      setDiagAllowMessage({
        kind: "ok",
        text: `${reports.length}개 디렉토리 등록 완료 — 패턴 ${patternCount}개 (인자 있음/없음 두 형태) + autoMode 자연어 entry`,
      });
      addEvent(
        "USER",
        `진단 SSH 자동 허용 등록 — ${reports.length}개 디렉토리`,
      );
      if (state.config.ui.auto_restart_claude_after_settings_change) {
        restartAllClaudes();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDiagAllowMessage({ kind: "err", text: msg });
    } finally {
      setDiagAllowBusy(false);
    }
  }

  async function handleRemoveDiagAllow() {
    if (state.status !== "ready") return;
    const sessions = state.config.claude_code_sessions;
    const dirs = [sessions.main.directory, ...sessions.additional.map((s) => s.directory)]
      .map((d) => d.trim())
      .filter((d) => d !== "");
    if (dirs.length === 0) {
      setDiagAllowMessage({
        kind: "err",
        text: "Claude 작업 디렉토리(메인/추가)를 먼저 설정하세요",
      });
      return;
    }
    setDiagAllowBusy(true);
    setDiagAllowMessage(null);
    try {
      const reports = [];
      for (const dir of dirs) {
        reports.push(await removeDiagSshAllow(dir));
      }
      const totalRemoved = reports.reduce((s, r) => s + r.removed_count, 0);
      setDiagAllowMessage({
        kind: "ok",
        text: `${reports.length}개 디렉토리 처리 — ${totalRemoved}개 패턴 제거`,
      });
      addEvent("USER", `진단 SSH 자동 허용 제거 — ${reports.length}개 디렉토리`);
      if (state.config.ui.auto_restart_claude_after_settings_change) {
        restartAllClaudes();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDiagAllowMessage({ kind: "err", text: msg });
    } finally {
      setDiagAllowBusy(false);
    }
  }

  async function handleInstallSafetyRules() {
    if (state.status !== "ready") return;
    const dir = state.config.claude_code_sessions.main.directory.trim();
    if (dir === "") {
      setSafetyMessage({
        kind: "err",
        text: "메인 Claude 작업 디렉토리를 먼저 설정하세요 ([일반] 탭)",
      });
      return;
    }
    setSafetyInstalling(true);
    setSafetyMessage(null);
    try {
      const report = await installClaudeSafetyRules(dir);
      const parts = [
        report.created ? "신규 생성" : "병합 완료",
        `deny ${report.deny_count}개 추가`,
      ];
      if (report.backed_up_path) {
        parts.push(`백업: ${report.backed_up_path}`);
      }
      setSafetyMessage({
        kind: "ok",
        text: `${parts.join(" · ")} → ${report.installed_path}`,
      });
      addEvent(
        "USER",
        `Claude 안전 규칙 설치 — ${dir} (deny ${report.deny_count})`,
      );
      if (state.config.ui.auto_restart_claude_after_settings_change) {
        restartAllClaudes();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSafetyMessage({ kind: "err", text: msg });
    } finally {
      setSafetyInstalling(false);
    }
  }

  async function handlePickWorkDir() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: "메인 Claude Code 작업 디렉토리 선택",
      });
      if (typeof selected === "string") {
        updateMainSession({ directory: selected });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPickError(message);
    }
  }

  async function handlePickBuildDir() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: "빌드 작업 디렉토리 선택",
      });
      if (typeof selected === "string") {
        updateDeploy({ build_working_directory: selected });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPickError(message);
    }
  }

  async function handlePickJar() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "빌드된 jar 파일 선택",
        filters: [
          { name: "JAR", extensions: ["jar"] },
          { name: "모든 파일", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string") {
        updateDeploy({ jar_output_path: selected });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPickError(message);
    }
  }

  // ============ Tab content renderers ============

  function renderGeneralTab() {
    return (
      <div className="grid gap-3">
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="main-claude-dir">
            메인 Claude Code 작업 디렉토리
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="main-claude-dir"
              value={config.claude_code_sessions.main.directory}
              readOnly
              disabled={!isReady}
              placeholder="경로 버튼으로 폴더 선택"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handlePickWorkDir}
              disabled={!isReady}
              title="폴더 선택"
            >
              <FolderOpen /> 경로
            </Button>
          </div>
          <label className="mt-1 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={config.claude_code_sessions.main.auto_start}
              onChange={(e) => updateMainSession({ auto_start: e.target.checked })}
              disabled={!isReady}
              className="size-3.5 accent-accent-gold"
            />
            앱 시작 시 <span className="font-mono">claude</span> CLI 자동 실행 (사양서 §5.1)
          </label>
        </div>

        <div className="my-1 h-px bg-foreground/20" />
        <div className="flex items-center gap-1.5 text-xs font-semibold text-card-foreground">
          <Bell className="size-3.5 text-action-green" />
          Claude Code 훅 통합
        </div>
        <p className="text-xs text-muted-foreground">
          메인 + 추가 Claude의 모든 작업 디렉토리(<span className="font-mono">.claude/settings.local.json</span>)에
          훅을 설치한다. 설치 후 Claude의 turn 종료/세션 시작/알림 등이 도구 콘솔에 표시되며,
          기존 설정과 병합되고 백업된다.
        </p>
        <div className="grid gap-1">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={config.ui.verbose_hook_logs}
              onChange={(e) => updateUi({ verbose_hook_logs: e.target.checked })}
              disabled={!isReady}
              className="size-3.5 accent-accent-gold"
            />
            훅 상세 로그 표시 (PreToolUse/PostToolUse — 시끄러움. 설정 변경은 다음 앱 재시작에 반영)
          </label>
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={config.ui.gate_dangerous_tools}
              onChange={(e) => updateUi({ gate_dangerous_tools: e.target.checked })}
              disabled={!isReady}
              className="size-3.5 accent-accent-gold"
            />
            위험 도구(Bash) 호출 시 모달로 확인받기 ({" "}
            <span className="font-mono">설정 변경 후 [훅 설치] 다시 클릭 필요</span>)
          </label>
          <label className="inline-flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={config.ui.auto_restart_claude_after_settings_change}
              onChange={(e) =>
                updateUi({
                  auto_restart_claude_after_settings_change: e.target.checked,
                })
              }
              disabled={!isReady}
              className="mt-0.5 size-3.5 accent-accent-gold"
            />
            <span>
              설정 변경 시 모든 Claude PTY 자동 재시작 ([훅 설치] / [진단 SSH 자동 허용 등록] / [안전 규칙 설치]).
              <br />
              <span className="text-destructive">
                주의 — 진행 중인 Claude turn이 끊깁니다.
              </span>
            </span>
          </label>
          <label className="inline-flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={config.ui.mask_ec2_ips}
              onChange={(e) => updateUi({ mask_ec2_ips: e.target.checked })}
              disabled={!isReady}
              className="mt-0.5 size-3.5 accent-accent-gold"
            />
            <span>
              EC2 SSH 패널 출력에서 호스트 IP 마스킹 (캡처/공유 직전에만 켜기 권장).
              <br />
              <span className="text-muted-foreground">
                저장 직후 새 출력부터 적용 — 이미 화면에 표시된 텍스트는 영향 없음.
                완전히 가리려면 EC2 패널에서 <span className="font-mono">clear</span> 입력.
              </span>
            </span>
          </label>
        </div>
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handleInstallHooks}
              disabled={!isReady || hookInstalling}
              title="메인 + 추가 Claude의 모든 작업 디렉토리에 훅 설치 (병합)"
            >
              <Bell />
              {hookInstalling ? "설치 중..." : "훅 설치"}
            </Button>
          </div>
          {hookMessage && (
            <p
              className={
                hookMessage.kind === "ok"
                  ? "text-xs text-action-green"
                  : hookMessage.kind === "err"
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
              }
            >
              {hookMessage.text}
            </p>
          )}
        </div>
      </div>
    );
  }

  function renderServerTab() {
    return (
      <div className="grid gap-3">
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="ec2-host">
            EC2 호스트 (IP 주소)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="ec2-host"
              type={showHost ? "text" : "password"}
              value={config.ec2.host}
              onChange={(e) => updateEc2({ host: e.target.value })}
              disabled={!isReady}
              placeholder="예: 12.34.56.78"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setShowHost((v) => !v)}
              aria-pressed={showHost}
              title={showHost ? "감추기" : "보기"}
            >
              {showHost ? <EyeOff /> : <Eye />} 보기
            </Button>
          </div>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="ec2-user">
            EC2 사용자 이름
          </label>
          <input
            id="ec2-user"
            value={config.ec2.user}
            onChange={(e) => updateEc2({ user: e.target.value })}
            disabled={!isReady}
            placeholder="예: ec2-user, ubuntu, admin"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="pem-path">
            개인키 경로 (.pem) — 빌드/배포·SSH·SFTP에 사용
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="pem-path"
              type={showKey ? "text" : "password"}
              value={config.ec2.private_key_path}
              readOnly
              disabled={!isReady}
              placeholder="경로 버튼으로 파일 선택"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
              title={showKey ? "감추기" : "보기"}
            >
              {showKey ? <EyeOff /> : <Eye />} 보기
            </Button>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handlePickKey}
              disabled={!isReady}
              title="파일 선택"
            >
              <FolderOpen /> 경로
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            파일 내용이 아닌 경로만 저장 (CLAUDE.md §1.2.1)
          </p>
          {pickError && (
            <p className="text-xs text-destructive">파일 선택 실패: {pickError}</p>
          )}
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="sftp-remote">
            SFTP 업로드 디렉토리 (원격)
          </label>
          <input
            id="sftp-remote"
            value={config.sftp.remote_upload_path}
            onChange={(e) => updateSftp({ remote_upload_path: e.target.value })}
            disabled={!isReady}
            placeholder="예: /home/ec2-user/uploads"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            jar 파일은 이 디렉토리 안에 동일 파일명으로 업로드됩니다.
          </p>
        </div>
      </div>
    );
  }

  function renderDeployTab() {
    return (
      <div className="grid gap-3">
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="build-cmd">
            빌드 명령
          </label>
          <input
            id="build-cmd"
            value={config.deploy.build_command}
            onChange={(e) => updateDeploy({ build_command: e.target.value })}
            disabled={!isReady}
            placeholder="예: gradlew.bat build, ./gradlew build, build.bat"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            셸로 실행됨 (Windows: cmd /c, Unix: sh -c). 인용/리다이렉션 사용 가능.
          </p>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="build-dir">
            빌드 작업 디렉토리
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="build-dir"
              value={config.deploy.build_working_directory}
              readOnly
              disabled={!isReady}
              placeholder="경로 버튼으로 폴더 선택"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handlePickBuildDir}
              disabled={!isReady}
              title="폴더 선택"
            >
              <FolderOpen /> 경로
            </Button>
          </div>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="jar-output">
            빌드된 jar 절대경로
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="jar-output"
              value={config.deploy.jar_output_path}
              onChange={(e) => updateDeploy({ jar_output_path: e.target.value })}
              disabled={!isReady}
              placeholder="예: D:\projects\myapp\build\libs\myapp.jar"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handlePickJar}
              disabled={!isReady}
              title="파일 선택"
            >
              <FolderOpen /> 경로
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            빌드 후 생성되는 jar 파일의 절대경로 (파일명이 매번 동일하다는 가정).
          </p>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="build-timeout">
            빌드 타임아웃 (초)
          </label>
          <input
            id="build-timeout"
            type="number"
            min={1}
            value={config.deploy.build_timeout_seconds}
            onChange={(e) =>
              updateDeploy({
                build_timeout_seconds: Math.max(
                  1,
                  Number.parseInt(e.target.value, 10) || 0,
                ),
              })
            }
            disabled={!isReady}
            className={INPUT_CLASS}
          />
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="deploy-script">
            배포 명령 (EC2에서 실행)
          </label>
          <input
            id="deploy-script"
            value={config.deploy.deploy_script}
            onChange={(e) => updateDeploy({ deploy_script: e.target.value })}
            disabled={!isReady}
            placeholder="예: cd /home/ec2-user && bash deploy.sh"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            SSH exec 채널로 실행. cd 등 cwd 이동은 명령에 직접 포함하세요.
          </p>
        </div>
      </div>
    );
  }

  function renderMonitorTab() {
    return (
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          메인 SSH에서 실시간으로 흐르는 로그를 감시해 ERROR 패턴이 보이면 컨텍스트를 좌측 메인 Claude로 자동 주입합니다 (사양서 §3.2 [4] / §3.6).
        </p>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="monitor-cmd">
            로그 모니터 명령 (메인 SSH에 자동 입력)
          </label>
          <input
            id="monitor-cmd"
            value={config.monitoring.log_command}
            onChange={(e) => updateMonitoring({ log_command: e.target.value })}
            disabled={!isReady}
            placeholder="예: sudo journalctl -u <service> -f"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            메인 SSH 연결 직후 자동 입력 (운영 중 ERROR도 잡기 위해 attempt와 무관하게 활성).
          </p>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="error-pat">
            ERROR 정규식 패턴
          </label>
          <input
            id="error-pat"
            value={config.monitoring.error_pattern}
            onChange={(e) => updateMonitoring({ error_pattern: e.target.value })}
            disabled={!isReady}
            placeholder="예: \[ERROR\]"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="ctx-before">
              직전 N줄
            </label>
            <input
              id="ctx-before"
              type="number"
              min={0}
              value={config.monitoring.context_lines_before}
              onChange={(e) =>
                updateMonitoring({
                  context_lines_before: Math.max(
                    0,
                    Number.parseInt(e.target.value, 10) || 0,
                  ),
                })
              }
              disabled={!isReady}
              className={`${INPUT_CLASS} w-full min-w-0`}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="ctx-after">
              직후 N줄
            </label>
            <input
              id="ctx-after"
              type="number"
              min={0}
              value={config.monitoring.context_lines_after}
              onChange={(e) =>
                updateMonitoring({
                  context_lines_after: Math.max(
                    0,
                    Number.parseInt(e.target.value, 10) || 0,
                  ),
                })
              }
              disabled={!isReady}
              className={`${INPUT_CLASS} w-full min-w-0`}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="ctx-delay">
              지연 (초)
            </label>
            <input
              id="ctx-delay"
              type="number"
              min={0}
              value={config.monitoring.context_capture_delay_seconds}
              onChange={(e) =>
                updateMonitoring({
                  context_capture_delay_seconds: Math.max(
                    0,
                    Number.parseInt(e.target.value, 10) || 0,
                  ),
                })
              }
              disabled={!isReady}
              className={`${INPUT_CLASS} w-full min-w-0`}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          ERROR 매칭 시 직전 N줄 + 매칭 라인 + 직후 N줄(또는 지연 초까지) + Caused by/stack 라인을 좌측 메인 Claude로 자동 주입.
        </p>
      </div>
    );
  }

  function renderDiagnosticTab() {
    return (
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          [자료 일괄 수집] / [시스템 데이터 수집] 버튼이 사용하는 진단 명령과 안전장치 (사양서 §3.3 [D3]).
          기본 명령 템플릿은 JVM/Spring Boot 가정이며 비-JVM 서비스는 아래 명령 오버라이드를 직접 작성하세요.
        </p>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="service-name">
            진단 대상 systemd 서비스 이름
          </label>
          <input
            id="service-name"
            value={config.monitoring.service_name}
            onChange={(e) => updateMonitoring({ service_name: e.target.value })}
            disabled={!isReady}
            placeholder="예: myapp, ***REDACTED-SERVICE***, api-server"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">systemctl status</span>·<span className="font-mono">journalctl -u</span>·<span className="font-mono">MainPID</span>{" "}
            조회에 사용. 비어있으면 [자료 일괄 수집] 버튼이 비활성됩니다.
          </p>
        </div>

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="collect-cmd">
            자료 수집 명령 오버라이드 (선택)
          </label>
          <textarea
            id="collect-cmd"
            value={config.monitoring.collect_command}
            onChange={(e) => updateMonitoring({ collect_command: e.target.value })}
            disabled={!isReady}
            placeholder="비워두면 내장 JVM/Spring Boot 템플릿 사용. 직접 작성 시 {service} placeholder는 위 서비스 이름으로 치환됩니다."
            spellCheck={false}
            className={TEXTAREA_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            한 줄에 한 명령씩 <span className="font-mono">;</span>로 연결한 단일 셸 라인을 권장 (작은따옴표 X — SSH 래핑과 충돌).
            비-JVM 서비스이거나 별도 진단 명령이 필요할 때만 사용하세요. 단, parser/Dashboard는 JVM 가정이라 카드 일부가 빌 수 있음.
          </p>
        </div>

        <div className="my-1 h-px bg-foreground/20" />
        <div className="flex items-center gap-1.5 text-xs font-semibold text-card-foreground">
          <ShieldCheck className="size-3.5 text-action-green" />
          Claude 시스템 진단 안전장치 (CLAUDE.md §1.2 / §1.3)
        </div>
        <p className="text-xs text-muted-foreground">
          메인 Claude가 EC2에 직접 SSH로 접속해 진단 정보를 수집할 때 사용하는 분리된 안전장치.
          서버 측 ForceCommand로 잠긴 진단 전용 키를 별도 등록한다.
          셋업 가이드: <span className="font-mono">docs/ec2-diag-setup/README.md</span>
        </p>

        <div className="grid gap-1">
          {(() => {
            // 원클릭 진단 셋업 사전 조건 — DiagSetupModal.start()의 검증과 1:1 일치.
            const missing: string[] = [];
            if (config.ec2.host.trim() === "") missing.push("EC2 호스트 ([서버] 탭)");
            if (config.ec2.user.trim() === "") missing.push("EC2 사용자 ([서버] 탭)");
            if (config.ec2.private_key_path.trim() === "")
              missing.push("개인키 경로 ([서버] 탭)");
            if (config.monitoring.service_name.trim() === "")
              missing.push("진단 대상 systemd 서비스 이름 (위 입력칸)");
            const blocked = !isReady || missing.length > 0;
            const tooltip =
              missing.length > 0
                ? `먼저 다음을 설정하세요: ${missing.join(", ")}`
                : "진단 키페어 생성 + EC2에 ForceCommand 잠금 셋업까지 자동 처리";
            return (
              <>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="default"
                    size="default"
                    onClick={() => setDiagSetupOpen(true)}
                    disabled={blocked}
                    title={tooltip}
                    className="[&_svg]:text-action-green"
                  >
                    <Stethoscope />
                    원클릭 진단 셋업
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  아래 진단 키 경로를 직접 셋업하지 않은 사용자를 위한 자동 도우미. 키페어 생성
                  → EC2에 셋업 파일 업로드 → install.sh 실행 → 키 경로 자동 등록까지 한 번에.
                  EC2 사용자가 sudo NOPASSWD여야 합니다.
                </p>
                {missing.length > 0 && isReady && (
                  <p className="text-xs text-destructive">
                    누락된 사전 설정: {missing.join(" · ")}
                  </p>
                )}
              </>
            );
          })()}
        </div>

        <div className="grid gap-1">
          <label
            className="text-xs text-muted-foreground"
            htmlFor="diag-pem-path"
          >
            진단 전용 키 경로 (ForceCommand로 잠긴 키)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="diag-pem-path"
              type={showDiagKey ? "text" : "password"}
              value={config.ec2.diag_private_key_path}
              readOnly
              disabled={!isReady}
              placeholder="가이드대로 발급한 진단 전용 키 (.pem) 선택"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setShowDiagKey((v) => !v)}
              aria-pressed={showDiagKey}
              title={showDiagKey ? "감추기" : "보기"}
            >
              {showDiagKey ? <EyeOff /> : <Eye />} 보기
            </Button>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handlePickDiagKey}
              disabled={!isReady}
              title="파일 선택"
            >
              <FolderOpen /> 경로
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            미설정 시 [시스템 데이터 수집] 버튼이 비활성됩니다. 배포용 키와 반드시 분리하세요.
          </p>
        </div>

        <div className="my-1 h-px bg-foreground/20" />
        <div className="flex items-center gap-1.5 text-xs font-semibold text-card-foreground">
          <ShieldCheck className="size-3.5 text-action-green" />
          진단 SSH 자동 허용 (Claude Code 권한 정책)
        </div>
        <p className="text-xs text-muted-foreground">
          메인 Claude의 [시스템 데이터 수집]은 운영 서버 SSH라서 Claude Code가 매번 승인을 요구한다.
          이 버튼은 두 게이트 모두에 등록한다 — host/user 정확 매칭 패턴을{" "}
          <span className="font-mono">permissions.allow</span>에, 그리고 auto mode classifier가
          이해할 수 있는 자연어 자기 설명을 <span className="font-mono">autoMode.allow</span>에.
          <strong> ForceCommand 셋업이 완료된 호스트에서만 사용</strong>하세요
          (셋업: <span className="font-mono">docs/ec2-diag-setup/README.md</span>).
        </p>
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handleInstallDiagAllow}
              disabled={
                !isReady ||
                diagAllowBusy ||
                config.ec2.host.trim() === "" ||
                config.ec2.user.trim() === ""
              }
              title={
                config.ec2.host.trim() === "" || config.ec2.user.trim() === ""
                  ? "[서버] 탭에서 host/user 먼저 설정"
                  : "메인 + 추가 Claude의 settings.local.json에 호스트 바운드 ssh 패턴 등록"
              }
            >
              <ShieldCheck />
              {diagAllowBusy ? "처리 중..." : "진단 SSH 자동 허용 등록"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={handleRemoveDiagAllow}
              disabled={!isReady || diagAllowBusy}
              title="등록된 진단 SSH 자동 허용 패턴 제거"
            >
              허용 규칙 제거
            </Button>
          </div>
          {diagAllowMessage && (
            <p
              className={
                diagAllowMessage.kind === "ok"
                  ? "text-xs text-action-green"
                  : diagAllowMessage.kind === "err"
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
              }
            >
              {diagAllowMessage.text}
            </p>
          )}
        </div>

        <div className="my-1 h-px bg-foreground/20" />
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground">
            로컬 보조 방어선 — Claude Code 권한 deny 규칙
          </label>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handleInstallSafetyRules}
              disabled={
                !isReady ||
                safetyInstalling ||
                config.claude_code_sessions.main.directory.trim() === ""
              }
              title="메인 Claude 작업 디렉토리의 .claude/settings.local.json에 위험 명령 deny 규칙 설치 (병합)"
            >
              <ShieldCheck />
              {safetyInstalling ? "설치 중..." : "안전 규칙 설치"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            rm/systemctl stop/scp/sftp/sudo 등 시스템 변경 패턴을 메인 Claude의
            <span className="font-mono"> .claude/settings.local.json</span>에 deny로 추가.
            기존 설정과 병합되며, 기존 파일은 자동 백업됩니다.
          </p>
          {safetyMessage && (
            <p
              className={
                safetyMessage.kind === "ok"
                  ? "text-xs text-action-green"
                  : safetyMessage.kind === "err"
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
              }
            >
              {safetyMessage.text}
            </p>
          )}
        </div>
      </div>
    );
  }

  function renderActiveTab() {
    switch (activeTab) {
      case "general":
        return renderGeneralTab();
      case "server":
        return renderServerTab();
      case "deploy":
        return renderDeployTab();
      case "monitor":
        return renderMonitorTab();
      case "diagnostic":
        return renderDiagnosticTab();
    }
  }

  return (
    <>
    <DiagSetupModal
      open={diagSetupOpen}
      onOpenChange={setDiagSetupOpen}
      onComplete={(path) => updateEc2({ diag_private_key_path: path })}
    />
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">설정</DialogTitle>
          <DialogDescription>
            Sidabari 설정 — 사양서 §5.2 스키마 기반 (개인키는 경로만 저장)
          </DialogDescription>
        </DialogHeader>

        {state.status === "loading" && (
          <p className="py-2 text-xs text-muted-foreground">설정 불러오는 중...</p>
        )}
        {state.status === "error" && (
          <p className="py-2 text-xs text-destructive">설정 로드 실패: {state.message}</p>
        )}

        <div className="flex min-h-0 gap-3">
          {/* 좌측 사이드바 */}
          <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-foreground/10 pr-2">
            {TABS.map(({ id, label, Icon }) => {
              const active = id === activeTab;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-secondary text-secondary-foreground ring-1 ring-ring ring-inset"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  aria-pressed={active}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </nav>

          {/* 우측 콘텐츠 */}
          <div className="min-h-0 flex-1 max-h-[60vh] overflow-y-auto pr-1">
            {renderActiveTab()}
          </div>
        </div>

        {saveError && (
          <p className="text-xs text-destructive">저장 실패: {saveError}</p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={saving}>
              취소
            </Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={!isReady || saving}>
            {saving ? "저장 중..." : "확인"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
