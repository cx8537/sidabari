// 사양서 §3.3 [D3] — ***REDACTED-SERVICE*** 시스템 진단 명령 라이브러리.
// EC2Panel(SSH 직접 실행)과 MainClaudePanel(Claude에게 SSH 위임)이 공유.
// PID는 systemd가 알려주는 MainPID로 동적 결정. JVM 명령은 PID 없으면 생략.
// 명령은 ; 로 연결해 일부 실패해도 다음 명령 진행 (정보 수집이 목적).
//
// 주의: 본문은 모두 큰따옴표만 사용 (작은따옴표 X). 이 덕분에
//   ssh user@host '<COLLECT_COMMAND>'
// 처럼 작은따옴표로 한 번에 감싸 원격 전달이 가능. 향후 작은따옴표가 들어가는
// 명령을 추가할 경우, ssh wrapping 방식을 heredoc(`bash -s` << 'EOF')으로 바꿔야 함.

export const SERVICE_NAME = "***REDACTED-SERVICE***";

export const COLLECT_COMMAND = [
  "clear",
  'PID=$(systemctl show -p MainPID --value ***REDACTED-SERVICE*** 2>/dev/null)',
  'echo "===== 자료 일괄 수집 (***REDACTED-SERVICE***) ====="',
  'echo "MainPID=$PID"',
  'echo ""',
  'echo "--- uptime ---"',
  "uptime",
  'echo ""',
  'echo "--- df -h ---"',
  "df -h",
  'echo ""',
  'echo "--- free -m ---"',
  "free -m",
  'echo ""',
  // swap 설정 — free/vmstat은 사용량/IO만, 설정(영속/우선순위/swappiness)은 별도로 봐야 함.
  'echo "--- swap 설정 ---"',
  "swapon --show 2>&1 || echo \"(swap 활성 X)\"",
  '(grep -iE "swap" /etc/fstab 2>/dev/null || echo "(fstab swap 항목 없음)")',
  "sysctl vm.swappiness vm.vfs_cache_pressure 2>&1",
  'echo ""',
  'echo "--- vmstat 1 3 ---"',
  "vmstat 1 3",
  'echo ""',
  'echo "--- top -b -n 1 (head 30) ---"',
  "top -b -n 1 | head -30",
  'echo ""',
  'echo "--- systemctl status ***REDACTED-SERVICE*** ---"',
  "sudo systemctl status ***REDACTED-SERVICE*** --no-pager -l | head -50",
  'echo ""',
  'echo "--- journalctl 5min ---"',
  "sudo journalctl -u ***REDACTED-SERVICE*** --since \"5 minutes ago\" --no-pager | tail -100",
  'echo ""',
  // 24시간 누적 ERROR/Exception — 반복 패턴 식별에 유리. count + 마지막 50줄.
  'echo "--- journalctl 24h ERROR/Exception 누적 ---"',
  "sudo journalctl -u ***REDACTED-SERVICE*** --since \"24 hours ago\" --no-pager 2>/dev/null | grep -cE \"ERROR|Exception\" | xargs -I{} echo \"24h ERROR/Exception 누적: {} 건\"",
  "sudo journalctl -u ***REDACTED-SERVICE*** --since \"24 hours ago\" --no-pager 2>/dev/null | grep -E \"ERROR|Exception\" | tail -50",
  'echo ""',
  'echo "--- ss -tlnp ---"',
  "sudo ss -tlnp 2>/dev/null",
  'echo ""',
  'echo "--- actuator/health ---"',
  '(curl -sf http://localhost:8080/actuator/health 2>&1 || echo "actuator unreachable")',
  'echo ""',
  // systemd PrivateTmp=true 환경에서 외부 jstack은 java의 attach socket(/tmp/.java_pid$PID)에 접근 못 함.
  // nsenter -t $PID -m으로 java 프로세스의 mount namespace에 진입해 같은 /tmp 보이게 함.
  // jmap -heap은 JDK 9+에서 deprecated → jcmd GC.heap_info / GC.class_histogram로 대체.
  'if [ -n "$PID" ]; then echo "--- jstack ---"; sudo nsenter -t $PID -m -- jstack $PID 2>&1 | head -120; echo ""; echo "--- jcmd GC.heap_info ---"; sudo nsenter -t $PID -m -- jcmd $PID GC.heap_info 2>&1 | head -40; echo ""; echo "--- jcmd GC.class_histogram (top 30) ---"; sudo nsenter -t $PID -m -- jcmd $PID GC.class_histogram 2>&1 | head -35; echo ""; echo "--- jstat -gc ---"; sudo jstat -gc $PID 1000 3; else echo "[알림] MainPID 없음 — JVM 명령 생략"; fi',
  'echo "===== 일괄 수집 종료 ====="',
].join("; ");

