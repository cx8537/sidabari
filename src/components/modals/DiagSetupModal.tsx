import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  listenSshExecDone,
  listenSshExecLine,
  sftpUpload,
  sshExec,
  type ExecDonePayload,
  type ExecLinePayload,
  type SshExecOptions,
} from "@/lib/ssh";
import {
  diagSetupCleanup,
  diagSetupPrepare,
} from "@/lib/diagSetup";
import { loadConfig, saveConfig } from "@/lib/config";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

// 사양서 §3.3 / docs/ec2-diag-setup/README.md — 원클릭 자동 셋업.
//
// 단계:
//   1. 진단 키페어 ensure (~/.ssh/sidabari-diag, 기존 있으면 재사용)
//   2. EC2에 임시 디렉토리 생성 (mkdir)
//   3. install.sh / sidabari-collect.sh / sidabari-diag.pub 업로드 (SFTP × 3)
//   4. install.sh 실행 (sudo로 ForceCommand 잠금 + sudoers + sidabari-collect 설치)
//   5. config.ec2.diag_private_key_path 자동 등록
//   6. staging 정리
//
// CLAUDE.md §1.3 "자동 실행 금지" 정신: 사용자가 [원클릭 진단 셋업] 버튼을 명시 클릭한 시점부터
// 진행되며, 단계 사이에 자동 retry는 하지 않는다. 실패 시 멈추고 사용자 결정.

type Status = "idle" | "running" | "success" | "error";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 셋업 성공 시 호출 — 부모(SettingsModal)가 메모리 state.config도 갱신해 [확인] 시 stale 덮어쓰기 방지. */
  onComplete?: (diagPrivateKeyPath: string) => void;
};

const TOTAL_STEPS = 6;

export function DiagSetupModal({ open, onOpenChange, onComplete }: Props) {
  const addEvent = useAppStore((s) => s.addEvent);
  const [status, setStatus] = useState<Status>("idle");
  const [stepIdx, setStepIdx] = useState(0);
  const [stepLabel, setStepLabel] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultKeyPath, setResultKeyPath] = useState<string | null>(null);
  // 모달 재오픈 시 상태 초기화. 단, running 중 닫히는 것은 막는다(아래 onOpenChange 핸들러).
  const startedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      // 닫힐 때 success/error면 상태 리셋해 다음 오픈에 깨끗하게 시작.
      if (status !== "running") {
        setStatus("idle");
        setStepIdx(0);
        setStepLabel("");
        setLogLines([]);
        setErrorMsg(null);
        setResultKeyPath(null);
        startedRef.current = false;
      }
    }
  }, [open, status]);

  function appendLog(line: string) {
    setLogLines((prev) => {
      const next = [...prev, line];
      // 너무 길어지면 앞부분 잘라 메모리 보호.
      if (next.length > 500) return next.slice(-500);
      return next;
    });
  }

  function setStep(idx: number, label: string) {
    setStepIdx(idx);
    setStepLabel(label);
    appendLog(`[${idx}/${TOTAL_STEPS}] ${label}`);
  }

  async function start() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("running");
    setErrorMsg(null);
    setLogLines([]);

    let setupId: string | null = null;

    try {
      // 0. 설정 로드 + 검증
      setStep(1, "설정 로드 / 검증");
      const cfg = await loadConfig();
      const ec2 = cfg.ec2;
      if (!ec2.host.trim() || !ec2.user.trim() || !ec2.private_key_path.trim()) {
        throw new Error(
          "EC2 host / user / 일반 .pem 경로가 모두 설정되어야 합니다 ([서버] 탭).",
        );
      }
      const svc = cfg.monitoring.service_name.trim();
      if (svc === "") {
        throw new Error(
          "진단 대상 systemd 서비스 이름이 설정되어야 합니다 ([시스템 진단] 탭).",
        );
      }

      // 1. 진단 키페어 + staging
      // 진단 키페어는 항상 표준 경로(~/.ssh/sidabari-diag)에 생성/재사용한다.
      // 사용자가 [진단 전용 키 경로] 자리에 배포용 .pem 등 잘못된 키를 등록한 상태여도
      // 셋업은 영향받지 않고 표준 경로로 진행 — 셋업 완료 시 그 경로가 자동 등록된다.
      setStep(2, "진단 키페어 준비 (~/.ssh/sidabari-diag)");
      const prep = await diagSetupPrepare(undefined);
      setupId = prep.setup_id;
      appendLog(
        prep.created_new_keypair
          ? `  새 ed25519 키페어 생성: ${prep.diag_private_key_path}`
          : `  기존 키페어 재사용: ${prep.diag_private_key_path}`,
      );
      appendLog(`  staging 디렉토리: ${prep.staging_install_path}`);
      appendLog(`  remote 셋업 디렉토리: ${prep.remote_setup_dir}`);

      const sshBase = {
        host: ec2.host,
        port: ec2.port,
        user: ec2.user,
        private_key_path: ec2.private_key_path,
      };

      // 2. EC2에 임시 디렉토리 생성
      setStep(3, "EC2에 임시 디렉토리 생성");
      await execAndWait(
        { ...sshBase, command: `mkdir -p ${prep.remote_setup_dir}` },
        (l) => appendLog(`  ${l.stream === "stderr" ? "(err) " : ""}${l.line}`),
      );

      // 3. SFTP × 3 (순차)
      setStep(4, "셋업 파일 업로드 (install.sh)");
      await sftpUpload({
        ...sshBase,
        local_path: prep.staging_install_path,
        remote_path: `${prep.remote_setup_dir}/install.sh`,
      });
      appendLog("  install.sh 업로드 완료");

      setStep(4, "셋업 파일 업로드 (sidabari-collect.sh)");
      await sftpUpload({
        ...sshBase,
        local_path: prep.staging_collect_path,
        remote_path: `${prep.remote_setup_dir}/sidabari-collect.sh`,
      });
      appendLog("  sidabari-collect.sh 업로드 완료");

      setStep(4, "셋업 파일 업로드 (sidabari-diag.pub)");
      await sftpUpload({
        ...sshBase,
        local_path: prep.staging_pub_path,
        remote_path: `${prep.remote_setup_dir}/sidabari-diag.pub`,
      });
      appendLog("  sidabari-diag.pub 업로드 완료");

      // 4. install.sh 실행 (sudo 사용 — EC2 기본 사용자 NOPASSWD 가정)
      setStep(5, "install.sh 실행 (sudo)");
      const safeSvc = svc.replace(/['"\\]/g, "");
      const installCmd = `cd ${prep.remote_setup_dir} && chmod +x install.sh sidabari-collect.sh && SIDABARI_SERVICE='${safeSvc}' bash ./install.sh`;
      await execAndWait(
        { ...sshBase, command: installCmd },
        (l) => appendLog(`  ${l.stream === "stderr" ? "(err) " : ""}${l.line}`),
      );

      // 5. config 갱신 — 디스크 + 부모 컴포넌트 메모리.
      setStep(6, "설정 갱신");
      cfg.ec2.diag_private_key_path = prep.diag_private_key_path;
      await saveConfig(cfg);
      onComplete?.(prep.diag_private_key_path);
      appendLog(`  config.ec2.diag_private_key_path = ${prep.diag_private_key_path}`);

      // 6. staging 정리 (실패해도 무해)
      await diagSetupCleanup(setupId).catch(() => {});
      setupId = null;

      setResultKeyPath(prep.diag_private_key_path);
      setStatus("success");
      addEvent(
        "USER",
        `진단 셋업 완료 — ${prep.diag_private_key_path}${prep.created_new_keypair ? " (신규 키)" : " (기존 키 재사용)"}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setStatus("error");
      addEvent("SYSTEM", `진단 셋업 실패: ${msg}`);
      // staging은 디버그 위해 남겨둠 (성공 시점에만 cleanup).
    } finally {
      startedRef.current = false;
    }
  }

  function handleClose() {
    if (status === "running") return; // 진행 중은 닫기 차단
    onOpenChange(false);
  }

  function handleRetry() {
    setStatus("idle");
    setStepIdx(0);
    setStepLabel("");
    setLogLines([]);
    setErrorMsg(null);
    setResultKeyPath(null);
    startedRef.current = false;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 진행 중에는 모달이 외부 클릭/ESC로 닫히지 않게.
        if (!o && status === "running") return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="bg-card sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">원클릭 진단 셋업</DialogTitle>
          <DialogDescription>
            진단 키페어를 <span className="font-mono">~/.ssh/sidabari-diag</span>에
            생성(기존 있으면 재사용)하고, EC2에 업로드 + ForceCommand 잠금 + 진단 키 경로 자동 등록까지
            처리합니다. EC2 사용자는 sudo가 NOPASSWD여야 하며, 셋업 후 sshd authorized_keys /
            sudoers.d / /usr/local/bin/이 변경됩니다. <strong>설정의 [진단 전용 키 경로]에 배포용
            .pem이 잘못 등록되어 있어도 영향 없이 진행</strong>됩니다 (셋업이 끝나면 표준 경로로 갱신).
          </DialogDescription>
        </DialogHeader>

        {status === "idle" && (
          <div className="grid gap-2 py-2 text-sm text-card-foreground">
            <p>다음 단계가 자동으로 실행됩니다:</p>
            <ol className="ml-4 list-decimal space-y-0.5 text-xs text-muted-foreground">
              <li>진단 키페어 ensure (<span className="font-mono">~/.ssh/sidabari-diag</span>, 기존 있으면 재사용)</li>
              <li>EC2 임시 디렉토리 생성 (<span className="font-mono">/tmp/sidabari-diag-setup-&lt;uuid&gt;</span>)</li>
              <li>install.sh / sidabari-collect.sh / sidabari-diag.pub SFTP 업로드</li>
              <li>EC2에서 <span className="font-mono">install.sh</span> 실행 (sudo)</li>
              <li>Sidabari 설정의 <span className="font-mono">diag_private_key_path</span> 자동 등록</li>
              <li>로컬 staging 디렉토리 정리</li>
            </ol>
          </div>
        )}

        {(status === "running" || status === "success" || status === "error") && (
          <div className="grid gap-2 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-2 rounded-full",
                  status === "running"
                    ? "animate-pulse bg-action-green"
                    : status === "success"
                      ? "bg-action-green"
                      : "bg-destructive",
                )}
              />
              <span className="text-card-foreground">
                {status === "running"
                  ? `${stepIdx}/${TOTAL_STEPS} — ${stepLabel}`
                  : status === "success"
                    ? "셋업 완료"
                    : "셋업 실패"}
              </span>
            </div>
            {resultKeyPath && status === "success" && (
              <p className="text-xs text-action-green">
                진단 전용 키 등록됨: <span className="font-mono">{resultKeyPath}</span>
                <br />
                이제 메인 Claude의 [시스템 데이터 수집]을 사용할 수 있습니다.
              </p>
            )}
            {errorMsg && status === "error" && (
              <p className="text-xs text-destructive">실패 사유: {errorMsg}</p>
            )}
            <pre className="max-h-72 overflow-auto rounded-md bg-background p-2 font-mono text-xs text-muted-foreground">
              {logLines.length === 0 ? "(로그 없음)" : logLines.join("\n")}
            </pre>
          </div>
        )}

        <DialogFooter>
          {status === "idle" && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                취소
              </Button>
              <Button onClick={start}>시작</Button>
            </>
          )}
          {status === "running" && (
            <Button variant="ghost" disabled>
              진행 중...
            </Button>
          )}
          {status === "success" && (
            <Button onClick={handleClose}>닫기</Button>
          )}
          {status === "error" && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                닫기
              </Button>
              <Button onClick={handleRetry}>다시 시도</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function execAndWait(
  opts: SshExecOptions,
  onLine?: (l: ExecLinePayload) => void,
): Promise<ExecDonePayload> {
  const execId = await sshExec(opts);
  const lineUnlisten = onLine ? await listenSshExecLine(execId, onLine) : null;
  return await new Promise<ExecDonePayload>((resolve, reject) => {
    listenSshExecDone(execId, (done) => {
      lineUnlisten?.();
      doneUnlisten?.();
      if (done.succeeded) resolve(done);
      else reject(new Error(`SSH 명령 실패: ${done.reason}`));
    })
      .then((u) => {
        doneUnlisten = u;
      })
      .catch((err) => {
        lineUnlisten?.();
        reject(err);
      });
    // eslint-disable-next-line prefer-const
    let doneUnlisten: (() => void) | null = null;
  });
}
