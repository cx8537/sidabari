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
  listenSftpProgress,
  listenSshExecDone,
  listenSshExecLine,
  sftpUpload,
  sftpUploadKill,
  sshExec,
  sshExecKill,
  sshWrite,
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

// 사람 가독성을 위한 단위 포맷. KB까지는 정수, MB부터 소수점 1자리.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  const mainEc2SessionId = useAppStore((s) => s.mainEc2SessionId);
  const mainEc2DiagSessionId = useAppStore((s) => s.mainEc2DiagSessionId);
  const activeDeployExecId = useAppStore((s) => s.activeDeployExecId);
  const activeUploadId = useAppStore((s) => s.activeUploadId);
  const setActiveDeployExecId = useAppStore((s) => s.setActiveDeployExecId);
  const setActiveUploadId = useAppStore((s) => s.setActiveUploadId);
  const beginAttempt = useAppStore((s) => s.beginAttempt);
  const finishAttempt = useAppStore((s) => s.finishAttempt);
  const abortAttempt = useAppStore((s) => s.abortAttempt);
  const addEvent = useAppStore((s) => s.addEvent);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const isRunning = status === "running";

  // 단계 사이 abort 가드 — sftp/exec await 도중에 abort돼도 다음 단계로 가지 않게.
  function isStillRunning(): boolean {
    return useAppStore.getState().attemptStatus === "running";
  }

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

    // upload_id를 frontend에서 생성 → store에 등록 → backend kill 가능.
    const uploadId = crypto.randomUUID();
    setActiveUploadId(uploadId);

    // 진행률 표시 — backend는 200ms마다 emit, 업로드 단계 콘솔 라인은 1초에 1번으로 throttle.
    // verifying 단계 진입은 1회성 알림이므로 별도 처리.
    let unlistenProgress: (() => void) | null = null;
    let lastConsoleEmit = 0;
    let verifyingLogged = false;
    try {
      unlistenProgress = await listenSftpProgress(uploadId, (p) => {
        if (p.phase === "verifying") {
          if (!verifyingLogged) {
            verifyingLogged = true;
            addEvent("UPLOAD", `[검증 중] 원격 sha256sum 대조...`);
          }
          return;
        }
        // phase === "uploading"
        const now = Date.now();
        if (now - lastConsoleEmit < 1000) return;
        lastConsoleEmit = now;
        const pctText =
          p.bytes_total && p.bytes_total > 0
            ? ` (${Math.floor((p.bytes_done * 100) / p.bytes_total)}%)`
            : "";
        const totalText = p.bytes_total
          ? ` / ${formatBytes(p.bytes_total)}`
          : "";
        addEvent(
          "UPLOAD",
          `   ${formatBytes(p.bytes_done)}${totalText}${pctText} @ ${formatBytes(p.speed_bps)}/s`,
        );
      });

      const result = await sftpUpload({
        upload_id: uploadId,
        host: e2.host,
        port: e2.port,
        user: e2.user,
        private_key_path: e2.private_key_path,
        local_path: localPath,
        remote_path: remotePath,
      });
      unlistenProgress?.();
      unlistenProgress = null;
      setActiveUploadId(null);
      addEvent(
        "UPLOAD",
        `[업로드 완료] ${result.bytes.toLocaleString()} bytes — sha256:${result.sha256.slice(0, 12)}…`,
      );
      // 사양서 §3.7 — 업로드 await 완료 후라도 abort 상태면 다음 단계 진행 X.
      if (!isStillRunning()) {
        addEvent("MONITOR", "[중단] attempt 비활성 — 배포 단계 생략");
        return;
      }
      // 사양서 §3.2 [3] — 자동으로 deploy.sh 실행 (실패 시 즉시 멈춤).
      await runDeploy(cfg);
    } catch (e) {
      unlistenProgress?.();
      unlistenProgress = null;
      setActiveUploadId(null);
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("MONITOR", `[업로드 실패] ${msg}`);
      // abort로 인한 실패면 status가 이미 aborted — finishAttempt 가드로 무시됨.
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
    if (!isStillRunning()) {
      addEvent("MONITOR", "[중단] attempt 비활성 — 배포 시작 생략");
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
          setActiveDeployExecId(execId);
          unlistenLine = await listenSshExecLine(execId, (p) => {
            const prefix = p.stream === "stderr" ? "[stderr] " : "";
            addEvent("DEPLOY", prefix + p.line);
          });
          unlistenDone = await listenSshExecDone(execId, (p) => {
            if (settled) return;
            settled = true;
            cleanup();
            setActiveDeployExecId(null);
            addEvent(
              p.succeeded ? "DEPLOY" : "MONITOR",
              `[배포 ${p.succeeded ? "성공" : "실패"}] ${p.reason}`,
            );
            // monitor는 EC2 메인 SSH 연결 시점부터 이미 흐르고 있음 (EC2Panel useEffect).
            // deploy.sh가 service stop+start 해도 journalctl -f가 새 startup 로그 그대로 받음.
            finishAttempt(p.succeeded);
            resolve();
          });
        })
        .catch((e) => {
          if (settled) return;
          settled = true;
          cleanup();
          setActiveDeployExecId(null);
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
        // 사양서 §3.7 — 빌드 후 abort 상태이면 다음 단계 진행 X.
        if (!isStillRunning()) {
          addEvent("MONITOR", "[중단] attempt 비활성 — 업로드 단계 생략");
          return;
        }
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
    // 사양서 §3.7 — 진행 중 명령에 Ctrl+C 전송, SSH 채널은 유지.
    // 1) 빌드 (로컬 process)
    if (attemptId) {
      try {
        await buildKill(attemptId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addEvent("SYSTEM", `빌드 중단 IPC 실패: ${msg}`);
      }
    }
    // 2) 진행 중 SFTP 업로드 — 청크 사이 cancel
    if (activeUploadId) {
      try {
        await sftpUploadKill(activeUploadId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addEvent("SYSTEM", `업로드 중단 IPC 실패: ${msg}`);
      }
    }
    // 3) 진행 중 ssh_exec (deploy 등) — SIGINT 전송 후 channel close
    if (activeDeployExecId) {
      try {
        await sshExecKill(activeDeployExecId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addEvent("SYSTEM", `배포 exec 중단 IPC 실패: ${msg}`);
      }
    }
    // 4) 메인 SSH 셸 — \x03 전송 (monitor 등 셸 명령 중단). SSH 채널 자체는 살림.
    if (mainEc2SessionId) {
      sshWrite(mainEc2SessionId, "\x03").catch(() => {});
    }
    // 5) 진단 SSH 셸 — \x03 전송 (사용자 ad-hoc 명령 진행 중일 수 있음).
    if (mainEc2DiagSessionId) {
      sshWrite(mainEc2DiagSessionId, "\x03").catch(() => {});
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
        <Play /> {starting ? "시작 중..." : "백엔드 배포 시작"}
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
