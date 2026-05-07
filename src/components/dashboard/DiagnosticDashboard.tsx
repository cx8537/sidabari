import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  RefreshCw,
  Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/useAppStore";
import { sshCollectExec } from "@/lib/ssh";
import { buildCollectCommand } from "@/lib/diagnostic";
import { loadConfig } from "@/lib/config";
import { stripAnsi } from "@/lib/ansi";
import {
  extractCompletedSegment,
  parseDiagnosticOutput,
  type DiagnosticMetrics,
} from "@/lib/parseDiagnostic";

// 사양서 §3.3 [D3] — 시스템 진단 대시보드.
// 데이터 소스: useAppStore.latestDiagnostic
//   - 두 갱신 경로:
//     (1) [새로고침] 버튼 — 헤드리스 ssh_collect_exec(터미널 패널 mount 불필요).
//     (2) EC2 진단 플로팅 패널의 [자료 일괄 수집] — 패널 SSH stream에서 종료 마커 감지.
//   - 어느 쪽이든 결과를 parseDiagnosticOutput으로 파싱해 store에 반영.
//
// 임계값(정상/주의/위험)은 1차로 hardcode → 추후 설정 모달로 분리 예정.

type Status = "ok" | "warn" | "danger" | "info";

type MetricCard = {
  label: string;
  value: string;
  status: Status;
  detail?: string;
};

const STATUS_LABEL: Record<Status, string> = {
  ok: "정상",
  warn: "주의",
  danger: "위험",
  info: "—",
};

function statusColor(s: Status): string {
  switch (s) {
    case "ok":
      return "text-action-green";
    case "warn":
      return "text-amber-400";
    case "danger":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function StatusIcon({ status }: { status: Status }) {
  const cls = "size-3.5";
  switch (status) {
    case "ok":
      return <CheckCircle2 className={cls} />;
    case "warn":
    case "danger":
      return <AlertTriangle className={cls} />;
    default:
      return <Info className={cls} />;
  }
}

// --- 임계값 분류 헬퍼 ---
function pctStatus(
  pct: number,
  warnAt: number,
  dangerAt: number,
): Status {
  if (pct >= dangerAt) return "danger";
  if (pct >= warnAt) return "warn";
  return "ok";
}
function loadStatus(load: number): Status {
  // 1코어 가정. 멀티코어면 실제 cpu 수 곱해야 함 — 향후 cpuinfo 추가하면 정밀화.
  if (load >= 4) return "danger";
  if (load >= 2) return "warn";
  return "ok";
}
function errorStatus(count: number): Status {
  if (count >= 1000) return "danger";
  if (count >= 100) return "warn";
  return "ok";
}
function svcStatus(state: string | undefined): Status {
  if (!state) return "info";
  if (state === "active") return "ok";
  if (state === "inactive" || state === "failed") return "danger";
  return "warn";
}
function actuatorStatus(s: string | undefined): Status {
  if (!s) return "info";
  if (s === "UP") return "ok";
  return "danger";
}

function fmtNum(n: number | undefined, digits = 0): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function buildCards(m: DiagnosticMetrics): MetricCard[] {
  return [
    {
      label: "Load Avg (1m)",
      value: fmtNum(m.load1, 2),
      status: m.load1 !== undefined ? loadStatus(m.load1) : "info",
      detail:
        m.load5 !== undefined && m.load15 !== undefined
          ? `5m ${m.load5.toFixed(2)} · 15m ${m.load15.toFixed(2)}`
          : undefined,
    },
    {
      label: "Memory",
      value: m.memUsedPct !== undefined ? `${fmtNum(m.memUsedPct, 0)}%` : "—",
      status:
        m.memUsedPct !== undefined ? pctStatus(m.memUsedPct, 80, 90) : "info",
      detail:
        m.memTotalMb !== undefined && m.memUsedMb !== undefined
          ? `${m.memUsedMb} / ${m.memTotalMb} MB used`
          : undefined,
    },
    {
      label: "Swap",
      value:
        m.swapUsedMb !== undefined ? `${m.swapUsedMb} MB` : "—",
      status:
        m.swapUsedMb === undefined
          ? "info"
          : m.swapUsedMb >= 100
            ? "warn"
            : m.swapUsedMb >= 500
              ? "danger"
              : "ok",
      detail:
        m.swapTotalMb !== undefined
          ? `${m.swapTotalMb} MB total${m.swappiness !== undefined ? ` · swappiness=${m.swappiness}` : ""}`
          : undefined,
    },
    {
      label: "Disk /",
      value: m.diskRootPct !== undefined ? `${m.diskRootPct}%` : "—",
      status:
        m.diskRootPct !== undefined
          ? pctStatus(m.diskRootPct, 80, 90)
          : "info",
      detail:
        m.diskRootUsed && m.diskRootTotal
          ? `${m.diskRootUsed} / ${m.diskRootTotal} used`
          : undefined,
    },
    {
      label: "JVM Heap",
      value:
        m.heapUsedPct !== undefined ? `${fmtNum(m.heapUsedPct, 0)}%` : "—",
      status:
        m.heapUsedPct !== undefined ? pctStatus(m.heapUsedPct, 70, 90) : "info",
      detail:
        m.heapTotalKb !== undefined && m.heapUsedKb !== undefined
          ? `${Math.round(m.heapUsedKb / 1024)} / ${Math.round(m.heapTotalKb / 1024)} MB used`
          : undefined,
    },
    {
      label: "GC (Full / Young)",
      value:
        m.gcFull !== undefined && m.gcYoung !== undefined
          ? `${m.gcFull} / ${m.gcYoung}`
          : "—",
      status: "info",
      detail:
        m.gcTime !== undefined ? `Total GC time ${m.gcTime}s` : undefined,
    },
    {
      label: "24h ERROR/Exception",
      value:
        m.errorsLast24h !== undefined ? `${m.errorsLast24h} 건` : "—",
      status:
        m.errorsLast24h !== undefined
          ? errorStatus(m.errorsLast24h)
          : "info",
    },
    {
      label: "Service",
      value: m.serviceState ?? "—",
      status: svcStatus(m.serviceState),
      detail: [
        m.serviceUptime ? `since ${m.serviceUptime}` : null,
        m.serviceMemory ? `RSS ${m.serviceMemory}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    },
    {
      label: "actuator/health",
      value: m.actuatorHealth ?? "—",
      status: actuatorStatus(m.actuatorHealth),
    },
  ];
}

// Mock — 데이터 들어오기 전 첫 화면용. 회색 톤.
const MOCK_CARDS: MetricCard[] = [
  { label: "Load Avg (1m)", value: "—", status: "info" },
  { label: "Memory", value: "—", status: "info" },
  { label: "Swap", value: "—", status: "info" },
  { label: "Disk /", value: "—", status: "info" },
  { label: "JVM Heap", value: "—", status: "info" },
  { label: "GC (Full / Young)", value: "—", status: "info" },
  { label: "24h ERROR/Exception", value: "—", status: "info" },
  { label: "Service", value: "—", status: "info" },
  { label: "actuator/health", value: "—", status: "info" },
];

function fmtRelative(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 5) return "방금";
  if (diffSec < 60) return `${diffSec}초 전`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  return new Date(ts).toLocaleString();
}

export function DiagnosticDashboard() {
  const metrics = useAppStore((s) => s.latestDiagnostic);
  const setLatestDiagnostic = useAppStore((s) => s.setLatestDiagnostic);
  const setActiveDiagExecId = useAppStore((s) => s.setActiveDiagExecId);
  const addEvent = useAppStore((s) => s.addEvent);

  const [refreshing, setRefreshing] = useState(false);
  const [serviceName, setServiceName] = useState<string>("");
  // 1분 주기 자동갱신 토글. 컴포넌트 unmount 시 자동 해제. 영구 저장 X — 세션 한정.
  const [autoRefresh, setAutoRefresh] = useState(false);
  // 마지막 갱신 시각의 상대 표시를 1초마다 다시 그림 — "방금" → "5초 전" 등.
  const [, force] = useState(0);
  useEffect(() => {
    if (!metrics) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [metrics]);

  // 헤더 표기용 서비스 이름 — 모달이 닫힌 직후에도 갱신되도록 metrics 변경마다 재로드.
  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (!cancelled) setServiceName(c.monitoring.service_name.trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [metrics]);

  const cards = metrics ? buildCards(metrics) : MOCK_CARDS;

  // 헤드리스 새로고침 — 진단 패널 mount 여부와 무관하게 백그라운드 SSH 채널로 일괄 수집 실행.
  // 키 우선순위: ec2.diag_private_key_path 있으면 진단 키(서버 ForceCommand가 sidabari-collect만 실행) →
  // 없으면 ec2.private_key_path(배포 키) + buildCollectCommand 클라이언트 명령.
  // exec_id를 미리 발급해 store(activeDiagExecId)에 기록 — [강제 중단] 통합.
  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);

    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[Dashboard] 새로고침 실패 — 설정 로드 오류: ${msg}`);
      setRefreshing(false);
      return;
    }
    const ec2 = cfg.ec2;
    const svc = cfg.monitoring.service_name.trim();
    if (!ec2.host.trim() || !ec2.user.trim()) {
      addEvent("SYSTEM", "[Dashboard] 새로고침 실패 — EC2 host/user 미설정");
      setRefreshing(false);
      return;
    }
    if (svc === "") {
      addEvent(
        "SYSTEM",
        "[Dashboard] 새로고침 실패 — 진단 서비스 이름 미설정 (설정 → 시스템 진단 탭)",
      );
      setRefreshing(false);
      return;
    }
    const diagKey = ec2.diag_private_key_path.trim();
    const useDiagKey = diagKey !== "";
    const keyPath = useDiagKey ? diagKey : ec2.private_key_path.trim();
    if (keyPath === "") {
      addEvent("SYSTEM", "[Dashboard] 새로고침 실패 — SSH 키 경로 미설정");
      setRefreshing(false);
      return;
    }

    let cmd: string;
    try {
      // 진단 키 + ForceCommand: 서버가 SSH_ORIGINAL_COMMAND를 무시하고 sidabari-collect만 실행 →
      // command 텍스트는 사실상 무관. 의미 있는 문자열만 보내 server log 가독성 확보.
      cmd = useDiagKey
        ? "sidabari-collect"
        : buildCollectCommand(svc, cfg.monitoring.collect_command);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[Dashboard] 새로고침 실패 — 명령 생성 오류: ${msg}`);
      setRefreshing(false);
      return;
    }

    const execId = crypto.randomUUID();
    setActiveDiagExecId(execId);
    addEvent(
      "USER",
      `[Dashboard] 백그라운드 자료 수집 시작 (${useDiagKey ? "진단 키" : "배포 키"})`,
    );

    try {
      const result = await sshCollectExec({
        host: ec2.host,
        port: ec2.port,
        user: ec2.user,
        private_key_path: keyPath,
        command: cmd,
        timeout_secs: 30,
        exec_id: execId,
      });

      if (result.killed) {
        addEvent("SYSTEM", "[Dashboard] 백그라운드 자료 수집 강제 중단됨");
        return;
      }
      if (result.timed_out) {
        addEvent(
          "SYSTEM",
          `[Dashboard] 백그라운드 자료 수집 타임아웃 (${(result.elapsed_ms / 1000).toFixed(1)}s) — 부분 출력으로 파싱 시도`,
        );
      } else if (!result.succeeded) {
        const stderrTail = result.stderr.trim().slice(-200);
        addEvent(
          "SYSTEM",
          `[Dashboard] 자료 수집 비정상 종료 — ${result.reason}${stderrTail ? `, stderr: ${stderrTail}` : ""}`,
        );
        // 부분 출력이 있으면 그래도 파싱 시도.
      }

      const cleaned = stripAnsi(result.stdout);
      const segment = extractCompletedSegment(cleaned);
      if (!segment) {
        addEvent(
          "SYSTEM",
          `[Dashboard] 종료 마커 미감지 — 갱신 보류 (수집 ${(result.stdout.length / 1024).toFixed(1)} KB, ${result.elapsed_ms} ms)`,
        );
        return;
      }
      try {
        const m = parseDiagnosticOutput(segment);
        setLatestDiagnostic(m);
        addEvent(
          "SYSTEM",
          `[Dashboard] 자료 수집 완료 — Dashboard 갱신 (${(result.stdout.length / 1024).toFixed(1)} KB, ${result.elapsed_ms} ms)`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addEvent("SYSTEM", `[Dashboard] 진단 파싱 실패: ${msg}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `[Dashboard] 백그라운드 자료 수집 실패: ${msg}`);
    } finally {
      setActiveDiagExecId(null);
      setRefreshing(false);
    }
  }

  // 자동갱신 — 1분마다 handleRefresh 호출. ref로 최신 클로저 참조해 deps에 handleRefresh 안 넣음.
  // 토글 ON/OFF만 effect를 재구성. 진행 중(refreshing)이면 다음 tick에서 자동 skip.
  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;
  useEffect(() => {
    if (!autoRefresh) return;
    addEvent("SYSTEM", "[Dashboard] 1분 자동갱신 ON");
    const t = setInterval(() => {
      void handleRefreshRef.current();
    }, 60_000);
    return () => {
      clearInterval(t);
      addEvent("SYSTEM", "[Dashboard] 1분 자동갱신 OFF");
    };
    // addEvent는 zustand action으로 stable 참조 — deps 흔들지 않음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden">
      {/* 상단 헤더 */}
      <div className="flex items-center justify-between gap-2 border-b border-foreground/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-card-foreground">
            시스템 진단 대시보드
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            서비스:{" "}
            <span className="font-mono">{serviceName || "(미설정)"}</span>
            {metrics && (
              <>
                {" "}· PID:{" "}
                <span className="font-mono">{metrics.servicePid ?? "—"}</span>
                {" "}· 마지막 갱신:{" "}
                <span className="font-mono">
                  {fmtRelative(metrics.collectedAt)}
                </span>
              </>
            )}
            {!metrics && (
              <>
                {" "}· 데이터 없음 ([새로고침] 클릭)
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant={autoRefresh ? "default" : "ghost"}
            onClick={() => setAutoRefresh((v) => !v)}
            className={cn(
              "transition-colors",
              autoRefresh
                ? "[&_svg]:text-action-green ring-1 ring-ring ring-inset"
                : "[&_svg]:text-muted-foreground",
            )}
            title={
              autoRefresh
                ? "자동갱신 ON — 1분마다 자료 일괄 수집 (다시 클릭하여 OFF)"
                : "자동갱신 OFF — 클릭 시 1분 주기로 자동 수집"
            }
            aria-pressed={autoRefresh}
          >
            <Timer />
            {autoRefresh ? "1분 자동갱신 ON" : "1분 자동갱신 OFF"}
          </Button>
          <Button
            size="xs"
            onClick={handleRefresh}
            disabled={refreshing}
            className="[&_svg]:text-action-green"
            title="백그라운드 SSH 채널로 자료 일괄 수집 후 자동 갱신 (30초 hard timeout, [강제 중단]으로 취소 가능)"
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "수집 중..." : "새로고침"}
          </Button>
        </div>
      </div>

      {/* 카드 그리드 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((m, i) => (
            <div
              key={i}
              className="rounded-md bg-card p-3 ring-1 ring-foreground/10"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">
                  {m.label}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-1 text-[10px]",
                    statusColor(m.status),
                  )}
                >
                  <StatusIcon status={m.status} />
                  {STATUS_LABEL[m.status]}
                </span>
              </div>
              <div
                className={cn(
                  "font-mono text-2xl font-semibold tabular-nums",
                  statusColor(m.status),
                )}
              >
                {m.value}
              </div>
              {m.detail && (
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  {m.detail}
                </div>
              )}
            </div>
          ))}
        </div>

        {!metrics && (
          <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-400">
              <Info className="size-3.5" /> 데이터 없음
            </div>
            아직 수집된 진단 자료가 없습니다. 위{" "}
            <span className="font-mono">[새로고침]</span> 버튼을 누르면 백그라운드
            SSH 채널로 자료를 일괄 수집하고 카드를 자동 갱신합니다.
          </div>
        )}
      </div>
    </div>
  );
}
