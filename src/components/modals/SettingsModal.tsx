import { useEffect, useState } from "react";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
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
import { useAppStore } from "@/store/useAppStore";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; config: Config }
  | { status: "error"; message: string };

const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  schema_version: 1,
  display_name: "또돌이",
  project: { name: "" },
  claude_code_sessions: {
    main: { label: "", directory: "", auto_start: false },
    additional: [],
  },
  ec2: { host: "", port: 22, user: "ubuntu", private_key_path: "" },
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
    log_command: "",
    error_pattern: "\\[ERROR\\]",
    context_lines_before: 30,
    context_lines_after: 10,
    context_capture_delay_seconds: 5,
  },
  safety: { ssh_disconnect_grace_seconds: 10 },
});

const INPUT_CLASS =
  "h-8 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50";

export function SettingsModal({ open, onOpenChange }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showHost, setShowHost] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    setSaveError(null);
    setPickError(null);
    setShowHost(false);
    setShowKey(false);
    loadConfig()
      .then((config) => {
        if (cancelled) return;
        setState({ status: "ready", config });
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

  async function handleSave() {
    if (state.status !== "ready") return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveConfig(state.config);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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

        <div className="grid gap-3 py-2">
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

          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="pem-path">
              개인키 경로 (.pem)
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
  );
}
