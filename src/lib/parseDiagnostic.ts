// 사양서 §3.3 [D3] — 자료 일괄 수집 텍스트 출력을 메트릭 객체로 파싱.
// EC2 진단 패널이 SSH stream에서 "===== 자료 일괄 수집 ..." ~ "===== 일괄 수집 종료 ====="
// 사이의 segment를 잘라서 이 함수에 넘기면 Dashboard가 쓸 수 있는 구조로 변환.
//
// 일부 필드 추출 실패는 자연스러움 — 부분 결과만 반환. Dashboard는 undefined를 "—"로 표시.
// 정규식은 출력 포맷에 의존하므로 COLLECT_COMMAND 변경 시 파서도 점검.

export type DiagnosticMetrics = {
  collectedAt: number; // Date.now()

  // System
  load1?: number;
  load5?: number;
  load15?: number;
  cpuIdle?: number;

  // Memory
  memTotalMb?: number;
  memUsedMb?: number;
  memUsedPct?: number;

  // Swap
  swapTotalMb?: number;
  swapUsedMb?: number;
  swappiness?: number;

  // Disk
  diskRootPct?: number;
  diskRootUsed?: string;
  diskRootTotal?: string;

  // Service
  serviceState?: string; // "active" / "inactive" / ...
  serviceSubState?: string; // "running" / "dead" / ...
  serviceUptime?: string; // "1h 32min ago" 등
  serviceMemory?: string; // "850.1M"
  servicePid?: string;

  // Actuator
  actuatorHealth?: string; // "UP" / "DOWN"

  // JVM Heap
  heapTotalKb?: number;
  heapUsedKb?: number;
  heapUsedPct?: number;

  // GC (jstat)
  gcYoung?: number;
  gcFull?: number;
  gcTime?: number; // 초 단위

  // Errors
  errorsLast24h?: number;
};

function extractSection(text: string, header: string): string | null {
  const idx = text.indexOf(header);
  if (idx < 0) return null;
  const start = idx + header.length;
  const after = text.slice(start);
  // 다음 섹션 헤더 또는 종료 마커 전까지
  const m = after.match(/\n---\s.+?\s---|\n=====/);
  if (!m || m.index === undefined) return after;
  return after.slice(0, m.index);
}

export function parseDiagnosticOutput(text: string): DiagnosticMetrics {
  // SSH PTY는 라인 종결자가 CRLF — split("\n") 후 각 라인에 `\r`이 남아
  // `\/$` 같은 end-of-line 앵커 정규식이 모두 실패한다 (Disk 카드가 비는 원인).
  // 진입 시점에 한 번에 정규화해 모든 정규식을 안전하게 만든다.
  text = text.replace(/\r/g, "");
  const m: DiagnosticMetrics = { collectedAt: Date.now() };

  // Load average — uptime 또는 top 헤더
  const load = text.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (load) {
    m.load1 = parseFloat(load[1]);
    m.load5 = parseFloat(load[2]);
    m.load15 = parseFloat(load[3]);
  }

  // CPU idle — top 헤더 "%Cpu(s):  0.0 us,  3.1 sy,  0.0 ni, 96.9 id, ..."
  const cpu = text.match(/%Cpu\(s\):.*?(\d+\.\d+)\s+id/);
  if (cpu) m.cpuIdle = parseFloat(cpu[1]);

  // Memory — free -m Mem 줄
  const mem = text.match(
    /^Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m,
  );
  if (mem) {
    const total = parseInt(mem[1], 10);
    const used = parseInt(mem[2], 10);
    if (total > 0) {
      m.memTotalMb = total;
      m.memUsedMb = used;
      m.memUsedPct = (used / total) * 100;
    }
  }

  // Swap — free -m Swap 줄
  const swap = text.match(/^Swap:\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (swap) {
    m.swapTotalMb = parseInt(swap[1], 10);
    m.swapUsedMb = parseInt(swap[2], 10);
  }

  // swappiness — sysctl 출력
  const sps = text.match(/vm\.swappiness\s*=\s*(\d+)/);
  if (sps) m.swappiness = parseInt(sps[1], 10);

  // Disk / — df -h 에서 mounted_on 이 "/" 인 행
  const lines = text.split("\n");
  for (const line of lines) {
    const dfMatch = line.match(/^\S+\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)%\s+\/$/);
    if (dfMatch) {
      m.diskRootTotal = dfMatch[1];
      m.diskRootUsed = dfMatch[2];
      m.diskRootPct = parseInt(dfMatch[3], 10);
      break;
    }
  }

  // Service — systemctl status
  const svc = text.match(
    /Active:\s+(\S+)(?:\s+\((\S+)\))?\s+since\s+[^;]+;\s+(.+)/,
  );
  if (svc) {
    m.serviceState = svc[1];
    m.serviceSubState = svc[2];
    m.serviceUptime = svc[3].trim();
  }
  const svcMem = text.match(/^\s+Memory:\s+(\S+)/m);
  if (svcMem) m.serviceMemory = svcMem[1];
  const svcPid = text.match(/^\s+Main PID:\s+(\d+)/m);
  if (svcPid) m.servicePid = svcPid[1];

  // Actuator health
  const act = text.match(/\{"status":"(\w+)"/);
  if (act) m.actuatorHealth = act[1];

  // JVM Heap — jcmd GC.heap_info "total 524288K, used 97468K"
  const heap = text.match(/total\s+(\d+)K,\s+used\s+(\d+)K/);
  if (heap) {
    const total = parseInt(heap[1], 10);
    const used = parseInt(heap[2], 10);
    if (total > 0) {
      m.heapTotalKb = total;
      m.heapUsedKb = used;
      m.heapUsedPct = (used / total) * 100;
    }
  }

  // jstat -gc — 마지막 데이터 행 컬럼: ... YGC YGCT FGC FGCT CGC CGCT GCT
  const jstat = extractSection(text, "--- jstat -gc ---");
  if (jstat) {
    const dataLines = jstat
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /^[\d.]/.test(l));
    if (dataLines.length > 0) {
      const cols = dataLines[dataLines.length - 1].split(/\s+/);
      // 컬럼 인덱스 (현재 출력 기준): 12=YGC 14=FGC 18=GCT (총 19개)
      if (cols.length >= 19) {
        const ygc = parseInt(cols[12], 10);
        const fgc = parseInt(cols[14], 10);
        const gct = parseFloat(cols[18]);
        if (!Number.isNaN(ygc)) m.gcYoung = ygc;
        if (!Number.isNaN(fgc)) m.gcFull = fgc;
        if (!Number.isNaN(gct)) m.gcTime = gct;
      }
    }
  }

  // 24h ERROR/Exception 누적
  const err24 = text.match(/24h ERROR\/Exception 누적:\s+(\d+)\s+건/);
  if (err24) m.errorsLast24h = parseInt(err24[1], 10);

  return m;
}

// 출력 stream 누적 buffer에서 가장 최근의 "수집 시작 ~ 종료" segment를 잘라냄.
// 종료 마커가 보일 때만 호출. segment 또는 null 반환.
const START_RE = /===== 자료 일괄 수집/;
const END_MARKER = "===== 일괄 수집 종료 =====";

export function extractCompletedSegment(buffer: string): string | null {
  const endIdx = buffer.lastIndexOf(END_MARKER);
  if (endIdx < 0) return null;
  // endIdx 이전의 가장 가까운 시작 마커 찾기
  const before = buffer.slice(0, endIdx);
  const startMatch = before.match(/===== 자료 일괄 수집[^\n]*=====[\s\S]*$/);
  if (!startMatch || startMatch.index === undefined) return null;
  return buffer.slice(startMatch.index, endIdx + END_MARKER.length);
}

export { START_RE, END_MARKER };
