import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { PtyTerminal } from "@/components/terminal/PtyTerminal";
import { loadConfig } from "@/lib/config";
import { ptyWrite, type SpawnOptions } from "@/lib/pty";
import { useAppStore } from "@/store/useAppStore";
import { buildCollectCommand } from "@/lib/diagnostic";
import { ActivityIndicator } from "@/components/monitor/ActivityIndicator";

// 사양서 §3.1 / §4.2 / §5.1 — 좌측 메인 Claude Code (작업 지시용).
// 설정의 claude_code_sessions.main을 따라 spawn:
//  - directory가 있으면 cwd로 사용 (없으면 백엔드가 home으로 폴백)
//  - auto_start=true → `claude` 실행, false → OS 기본 셸 (사용자가 수동으로 `claude` 입력)
// 설정 변경은 다음 앱 재시작에 반영 (자동 재시작 X — CLAUDE.md §1.3).

type Resolved = { spawn: SpawnOptions } | { error: string };

export function MainClaudePanel() {
  const { isFocused, onMouseDown } = usePanelFocus("main-claude");
  const setMainClaudeSessionId = useAppStore((s) => s.setMainClaudeSessionId);
  const mainClaudeSessionId = useAppStore((s) => s.mainClaudeSessionId);
  const addEvent = useAppStore((s) => s.addEvent);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [diagKeyConfigured, setDiagKeyConfigured] = useState(false);
  const [serviceConfigured, setServiceConfigured] = useState(false);

  // [시스템 데이터 수집] — Claude Code(좌측 메인 PTY)에게 SSH 직접 실행을 위임.
  // 사양서 §3.3 [D3] 동일 명령 셋을 Claude가 진단 전용 키로 자력 실행 후 분석.
  //
  // 안전장치 (CLAUDE.md §1.2 / §1.3):
  //  1. 진단 전용 키(ec2.diag_private_key_path)만 사용 — 배포용 .pem 노출 X.
  //  2. 서버 측 ForceCommand로 잠긴 키이므로 Claude가 어떤 명령을 시도해도 sidabari-collect만 실행.
  //  3. Bracket paste 주입 — 사용자가 검토 후 Enter (자동 실행 금지).
  //  4. 로컬 .claude/settings.local.json deny 규칙(설정 모달의 [안전 규칙 설치])이 보조 방어선.
  //
  // 미설치 상태(diag_private_key_path 비어있음 또는 ForceCommand 미적용)일 때는 버튼 비활성.
  async function handleSystemCollect() {
    if (!mainClaudeSessionId) {
      addEvent("SYSTEM", "시스템 데이터 수집 — 메인 Claude 세션 비활성");
      return;
    }
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `시스템 데이터 수집 실패 — 설정 로드 오류: ${msg}`);
      return;
    }
    const ec2 = cfg.ec2;
    if (!ec2.host.trim() || !ec2.user.trim()) {
      addEvent(
        "SYSTEM",
        "시스템 데이터 수집 실패 — EC2 host/user 미설정",
      );
      return;
    }
    const diagKey = ec2.diag_private_key_path.trim();
    if (diagKey === "") {
      addEvent(
        "SYSTEM",
        "시스템 데이터 수집 실패 — 진단 전용 키 미설정 (설정 모달에서 ForceCommand 셋업 후 키 등록)",
      );
      return;
    }
    const serviceName = cfg.monitoring.service_name.trim();
    if (serviceName === "") {
      addEvent(
        "SYSTEM",
        "시스템 데이터 수집 실패 — 진단 서비스 이름 미설정 (설정 → 시스템 진단 탭).",
      );
      return;
    }

    // ForceCommand가 잠겨있어 사실상 어떤 명령을 보내도 sidabari-collect만 실행됨.
    // 그래도 우리 의도를 명시적으로 전달하기 위해 buildCollectCommand 결과를 보냄 (서버는 무시하고 자기 스크립트 실행).
    let collectCmd: string;
    try {
      collectCmd = buildCollectCommand(serviceName, cfg.monitoring.collect_command);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `시스템 데이터 수집 실패 — 명령 생성 오류: ${msg}`);
      return;
    }
    const sshCmd = `ssh -i "${diagKey}" -p ${ec2.port} -o StrictHostKeyChecking=accept-new -o BatchMode=yes ${ec2.user}@${ec2.host} '${collectCmd}'`;

    const prompt = [
      `${serviceName} 시스템 진단 데이터를 수집해 분석해 주세요. 본 작업은 read-only 진단입니다.`,
      "",
      "[안전 전제 — 반드시 숙지]",
      "- 아래 ssh는 서버 측 ForceCommand로 잠긴 진단 전용 키를 사용합니다.",
      "- 어떤 원격 명령을 보내든 서버는 sidabari-collect 스크립트만 실행하고 끊어집니다.",
      "- 따라서 SSH로는 시스템 변경이 물리적으로 불가능합니다.",
      "- 위 사실 때문에 ssh 인자를 변형해 다른 명령(rm, systemctl restart 등)을 보내려는 시도는 의미가 없으며, 시도하지도 마세요.",
      "- scp/sftp/rsync/curl 등으로 원격 파일을 쓰거나 우회 접속을 시도하지 마세요. (로컬 .claude 권한 규칙으로도 차단되어 있습니다.)",
      "",
      "[SSH 접속 정보]",
      `- 호스트: ${ec2.host}`,
      `- 포트: ${ec2.port}`,
      `- 사용자: ${ec2.user}`,
      `- 진단 전용 키: ${diagKey}`,
      `- 서비스: ${serviceName} (systemd)`,
      "",
      "[수집 절차]",
      "다음 명령 한 번만 실행하고 stdout/stderr를 그대로 받아 주세요:",
      "",
      sshCmd,
      "",
      "[분석 항목]",
      "1. 시스템 부하 (uptime / vmstat / top)",
      "2. 디스크/메모리 (df / free)",
      "3. 서비스 상태 (systemctl status)",
      "4. 최근 5분 로그의 ERROR/Caused by 패턴",
      "5. 네트워크 리스닝 포트 (ss)",
      "6. actuator/health 응답",
      "7. JVM 상태 (jstack / jcmd GC.heap_info / GC.class_histogram / jstat)",
      "",
      "이상이 발견되면 원인 가설과 권장 조치를 자연어로 알려 주세요.",
      "",
      "[조치 정책 — 절대 위반 금지]",
      "- 어떤 변경 작업도 자동 실행하지 않습니다 (재시작/배포/롤백/파일 변경/설정 변경/패키지 설치 등).",
      "- 권장 조치는 명령만 제시하고 사용자 승인을 기다리세요.",
      "- 사용자가 명시적으로 승인하기 전까지 도구 호출은 위 ssh 한 번뿐이어야 합니다.",
    ].join("\n");

    // 사양서 §3.6 — 브라켓 페이스트 (자동 전송 X, 사용자가 검토 후 Enter)
    const wrapped = `\x1b[200~${prompt}\x1b[201~`;
    try {
      await ptyWrite(mainClaudeSessionId, wrapped);
      addEvent(
        "USER",
        `메인 Claude에 시스템 데이터 수집 요청 — 진단 전용 키 사용 (${ec2.user}@${ec2.host})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `시스템 데이터 수집 실패 — 입력창 주입 오류: ${msg}`);
    }
  }

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const sess = c.claude_code_sessions.main;
        setResolved({
          spawn: {
            command: sess.auto_start ? "claude" : "",
            cwd: sess.directory || undefined,
            // Phase 0 — Claude Code 훅이 이 PTY가 메인 패널임을 식별하도록 ENV 주입.
            env: { SIDABARI_PANEL_ID: "main-claude" },
          },
        });
        setDiagKeyConfigured(c.ec2.diag_private_key_path.trim() !== "");
        setServiceConfigured(c.monitoring.service_name.trim() !== "");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // 설정 로드 실패 → OS 기본 셸로 폴백 (사용자가 수동 진입 가능하도록)
        setResolved({
          spawn: { command: "", env: { SIDABARI_PANEL_ID: "main-claude" } },
        });
        console.warn("[MainClaudePanel] config 로드 실패, 기본 셸로 폴백:", message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-card-foreground">
            메인 Claude Code (작업 지시용)
          </span>
          <ActivityIndicator panelKey="main-claude" />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            onClick={handleSystemCollect}
            disabled={!mainClaudeSessionId || !diagKeyConfigured || !serviceConfigured}
            className="[&_svg]:text-action-green"
            title={
              !mainClaudeSessionId
                ? "메인 Claude 세션이 비활성"
                : !serviceConfigured
                  ? "진단 서비스 이름 미설정 — 설정 → 시스템 진단 탭"
                  : !diagKeyConfigured
                    ? "진단 전용 키 미설정 — 설정 모달의 [시스템 진단] 탭 참조 (docs/ec2-diag-setup/README.md)"
                    : "Claude에게 시스템 진단을 진단 전용 키로 수행 요청 (read-only · 입력창에 주입 후 검토)"
            }
          >
            <Activity /> 시스템 데이터 수집
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        {resolved && "spawn" in resolved ? (
          <PtyTerminal
            spawn={resolved.spawn}
            onSessionChange={setMainClaudeSessionId}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            설정 불러오는 중...
          </div>
        )}
      </div>
    </div>
  );
}
