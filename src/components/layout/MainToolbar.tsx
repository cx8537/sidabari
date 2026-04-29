import { useState } from "react";
import { Play, Settings, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore, type AttemptStatus } from "@/store/useAppStore";
import { SettingsModal } from "@/components/modals/SettingsModal";
import { type Config, loadConfig } from "@/lib/config";
import {
  buildKill,
  buildStart,
  listenBuildDone,
  listenBuildLine,
} from "@/lib/build";
import {
  listenSshExecDone,
  listenSshExecLine,
  sftpUpload,
  sshExec,
} from "@/lib/ssh";

// 경로 helper — basename은 Windows `\`와 Unix `/` 둘 다 처리.
function basename(p: string): string {
  const last = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return last >= 0 ? p.slice(last + 1) : p;
}

function joinRemote(dir: string, name: string): string {
  const trimDir = dir.replace(/\/+$/, "");
  return `${trimDir}/${name}`;
}

function statusColor(status: AttemptStatus): string {
  switch (status) {
    case "running":
      return "text-accent-gold";
    case "succeeded":
      return "text-action-green";
    case "failed":
    case "aborted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function MainToolbar() {
  const status = useAppStore((s) => s.attemptStatus);
  const attemptId = useAppStore((s) => s.attemptId);
  const beginAttempt = useAppStore((s) => s.beginAttempt);
  const finishAttempt = useAppStore((s) => s.finishAttempt);
  const abortAttempt = useAppStore((s) => s.abortAttempt);
  const addEvent = useAppStore((s) => s.addEvent);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const isRunning = status === "running";

  async function runUpload(cfg: Config) {
    const d = cfg.deploy;
    const e2 = cfg.ec2;
    const sftp = cfg.sftp;

    if (!d.jar_output_path.trim()) {
      addEvent("MONITOR", "[업로드 실패] jar 출력 경로 미설정");
      finishAttempt(false);
      return;
    }
    if (!sftp.remote_upload_path.trim()) {
      addEvent("MONITOR", "[업로드 실패] SFTP 원격 디렉토리 미설정");
      finishAttempt(false);
      return;
    }
    if (!e2.host.trim() || !e2.user.trim() || !e2.private_key_path.trim()) {
      addEvent("MONITOR", "[업로드 실패] EC2 host/user/개인키 누락");
      finishAttempt(false);
      return;
    }

    const localPath = d.jar_output_path;
    const fileName = basename(localPath);
    const remotePath = joinRemote(sftp.remote_upload_path, fileName);

    addEvent("UPLOAD", `$ sftp put ${localPath}`);
    addEvent("UPLOAD", `   → ${e2.user}@${e2.host}:${remotePath}`);
    try {
      const bytes = await sftpUpload({
        host: e2.host,
        port: e2.port,
        user: e2.user,
        private_key_path: e2.private_key_path,
        local_path: localPath,
        remote_path: remotePath,
      });
      addEvent("UPLOAD", `[업로드 완료] ${bytes.toLocaleString()} bytes`);
      // 사양서 §3.2 [3] — 자동으로 deploy.sh 실행 (실패 시 즉시 멈춤).
      await runDeploy(cfg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("MONITOR", `[업로드 실패] ${msg}`);
      finishAttempt(false);
    }
  }

  async function runDeploy(cfg: Config): Promise<void> {
    const e2 = cfg.ec2;
    const script = cfg.deploy.deploy_script;
    if (!script.trim()) {
      addEvent("MONITOR", "[배포 실패] 배포 명령 미설정");
      finishAttempt(false);
      return;
    }

    addEvent("DEPLOY", `$ ssh ${e2.user}@${e2.host} -- ${script}`);

    return new Promise<void>((resolve) => {
      let unlistenLine: (() => void) | null = null;
      let unlistenDone: (() => void) | null = null;
      let settled = false;
      const cleanup = () => {
        unlistenLine?.();
        unlistenDone?.();
      };

      sshExec({
        host: e2.host,
        port: e2.port,
        user: e2.user,
        private_key_path: e2.private_key_path,
        command: script,
      })
        .then(async (execId) => {
          unlistenLine = await listenSshExecLine(execId, (p) => {
            const prefix = p.stream === "stderr" ? "[stderr] " : "";
            addEvent("DEPLOY", prefix + p.line);
          });
          unlistenDone = await listenSshExecDone(execId, (p) => {
            if (settled) return;
            settled = true;
            cleanup();
            addEvent(
              p.succeeded ? "DEPLOY" : "MONITOR",
              `[배포 ${p.succeeded ? "성공" : "실패"}] ${p.reason}`,
            );
            finishAttempt(p.succeeded);
            resolve();
          });
        })
        .catch((e) => {
          if (settled) return;
          settled = true;
          cleanup();
          const msg = e instanceof Error ? e.message : String(e);
          addEvent("MONITOR", `[배포 실패] ${msg}`);
          finishAttempt(false);
          resolve();
        });
    });
  }

  async function handleStart() {
    if (isRunning || starting) return;
    setStarting(true);
    try {
      const cfg = await loadConfig();
      const d = cfg.deploy;
      if (!d.build_command.trim()) {
        addEvent("SYSTEM", "빌드 명령 미설정 — 설정 모달에서 입력 필요");
        return;
      }
      if (!d.build_working_directory.trim()) {
        addEvent("SYSTEM", "빌드 작업 디렉토리 미설정");
        return;
      }

      const id = await buildStart({
        command: d.build_command,
        working_directory: d.build_working_directory,
        timeout_seconds: d.build_timeout_seconds,
      });
      beginAttempt(id);
      addEvent("BUILD", `$ ${d.build_command}  (cwd=${d.build_working_directory})`);

      const unlistenLine = await listenBuildLine(id, (p) => {
        const prefix = p.stream === "stderr" ? "[stderr] " : "";
        addEvent("BUILD", prefix + p.line);
      });
      const unlistenDone = await listenBuildDone(id, async (p) => {
        unlistenLine();
        unlistenDone();
        if (!p.succeeded) {
          addEvent("MONITOR", `[빌드 실패] ${p.reason}`);
          finishAttempt(false);
          return;
        }
        addEvent("BUILD", `[빌드 성공] ${p.reason}`);
        // 사양서 §3.2 [2] — 자동으로 jar 업로드 진행 (실패 시 즉시 멈춤).
        await runUpload(cfg);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("MONITOR", `빌드 시작 실패: ${msg}`);
      finishAttempt(false);
    } finally {
      setStarting(false);
    }
  }

  async function handleAbort() {
    if (!isRunning) return;
    abortAttempt();
    if (attemptId) {
      try {
        await buildKill(attemptId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addEvent("SYSTEM", `빌드 중단 IPC 실패: ${msg}`);
      }
    }
  }

  return (
    <header className="flex items-center gap-2 bg-card px-3 py-2">
      <span className="mr-2 text-sm font-semibold text-accent-gold">또돌이</span>
      <span className="text-xs text-[#E4E6EA]">
        상태: <span className={cn("font-medium", statusColor(status))}>{status}</span>
      </span>
      <div aria-hidden="true" className="h-5 w-px bg-foreground/20" />
      <Button
        size="sm"
        onClick={handleStart}
        disabled={isRunning || starting}
        className="[&_svg]:text-action-green"
        title="새 Attempt 시작 (사양서 §3.1)"
      >
        <Play /> {starting ? "시작 중..." : "시도 시작"}
      </Button>
      <Button
        size="sm"
        onClick={handleAbort}
        disabled={!isRunning}
        className="[&_svg]:text-destructive"
        title="진행 중 Attempt 강제 중단 (Ctrl+C 전송, SSH 채널 유지)"
      >
        <Square /> 강제 중단
      </Button>
      <div aria-hidden="true" className="h-5 w-px bg-foreground/20" />
      <Button size="icon-sm" onClick={() => setSettingsOpen(true)} title="설정">
        <Settings />
      </Button>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
