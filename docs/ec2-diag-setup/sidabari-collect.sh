#!/usr/bin/env bash
# Sidabari 진단 전용 SSH ForceCommand 스크립트.
# 이 키로 들어오는 모든 SSH 요청에서 sshd가 사용자가 보낸 명령을 무시하고 이 스크립트만 실행한다.
# 결과적으로 진단 전용 키가 통째로 유출돼도 시스템 변경은 물리적으로 불가능.
#
# 위치: /usr/local/bin/sidabari-collect (root 소유, 0755)
# 호출: authorized_keys의 command="..." 옵션이 자동 invocation
#
# 출력은 stdout으로만 — Claude(SSH 클라이언트 측)가 그대로 받아 분석한다.
# stderr가 섞이면 분석 노이즈가 커져 head -N 컷에서 중요 정보 잘릴 수 있어 2>&1 사용.

set -uo pipefail

# 환경변수 파일 source — install.sh가 /etc/default/sidabari-collect에 SIDABARI_SERVICE를 기록.
# ForceCommand로 호출되면 sshd가 /etc/default/*를 자동 source하지 않으므로 여기서 명시적으로 처리.
if [ -f /etc/default/sidabari-collect ]; then
  # shellcheck disable=SC1091
  . /etc/default/sidabari-collect
fi

SERVICE_NAME="${SIDABARI_SERVICE:-}"
if [ -z "$SERVICE_NAME" ]; then
  echo "[ERROR] SIDABARI_SERVICE 미설정 — /etc/default/sidabari-collect 확인" >&2
  exit 1
fi
PID="$(systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo "")"

echo "===== 자료 일괄 수집 ($SERVICE_NAME) ====="
echo "MainPID=$PID"
echo "Host=$(hostname)"
echo "Date=$(date -Is)"
echo ""

echo "--- uptime ---"
uptime
echo ""

echo "--- df -h ---"
df -h
echo ""

echo "--- free -m ---"
free -m
echo ""

echo "--- vmstat 1 3 ---"
vmstat 1 3
echo ""

echo "--- top -b -n 1 (head 30) ---"
top -b -n 1 | head -30
echo ""

echo "--- systemctl status $SERVICE_NAME ---"
systemctl status "$SERVICE_NAME" --no-pager -l 2>&1 | head -50
echo ""

echo "--- journalctl 5min ---"
journalctl -u "$SERVICE_NAME" --since "5 minutes ago" --no-pager 2>&1 | tail -100
echo ""

echo "--- ss -tlnp ---"
ss -tlnp 2>&1
echo ""

echo "--- actuator/health ---"
curl -sf --max-time 3 http://localhost:8080/actuator/health 2>&1 || echo "actuator unreachable"
echo ""

if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  # systemd PrivateTmp=true 환경에서 attach socket(/tmp/.java_pid$PID)에 접근하려면
  # java 프로세스의 mount namespace로 들어가야 함. 진단 사용자는 NOPASSWD 화이트리스트 sudo로 nsenter/jcmd만 허용.
  echo "--- jstack ---"
  sudo nsenter -t "$PID" -m -- jstack "$PID" 2>&1 | head -120
  echo ""
  echo "--- jcmd GC.heap_info ---"
  sudo nsenter -t "$PID" -m -- jcmd "$PID" GC.heap_info 2>&1 | head -40
  echo ""
  echo "--- jcmd GC.class_histogram (top 30) ---"
  sudo nsenter -t "$PID" -m -- jcmd "$PID" GC.class_histogram 2>&1 | head -35
  echo ""
  echo "--- jstat -gc ---"
  sudo jstat -gc "$PID" 1000 3 2>&1
else
  echo "[알림] MainPID 없음 — JVM 명령 생략"
fi
echo "===== 일괄 수집 종료 ====="
