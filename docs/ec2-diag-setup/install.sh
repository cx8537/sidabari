#!/usr/bin/env bash
# Sidabari 진단 전용 SSH 키 + ForceCommand 셋업 스크립트.
# EC2에 ec2-user(또는 ubuntu)로 SSH 접속한 상태에서 1회 실행.
#
# 사전 조건:
#   - 이 디렉토리에 sidabari-collect.sh 이 함께 있어야 함 (scp 등으로 미리 올림).
#   - 진단 전용 공개키 파일을 같은 디렉토리에 sidabari-diag.pub 으로 미리 둠.
#     (로컬에서 ssh-keygen -t ed25519 -f ~/.ssh/sidabari-diag -N "" -C sidabari-diagnostic 후
#      sidabari-diag.pub 파일을 EC2로 업로드)
#
# 결과:
#   - /usr/local/bin/sidabari-collect 설치 (root:root, 0755).
#   - 현재 사용자의 ~/.ssh/authorized_keys 에 진단 키를 ForceCommand로 잠금 추가.
#   - sudoers.d/sidabari-diag 설치 (NOPASSWD 화이트리스트: nsenter+jstack/jcmd, jstat 만).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 사용자가 진단 대상 systemd 서비스 이름을 환경변수로 명시해야 함.
# 기본값을 두지 않음 — 잘못된 서비스에 부착되는 사고 방지.
if [ -z "${SIDABARI_SERVICE:-}" ]; then
  echo "[ERROR] SIDABARI_SERVICE 환경변수가 필요합니다. 사용법:" >&2
  echo "    SIDABARI_SERVICE=your-systemd-service-name ./install.sh" >&2
  echo "  예) SIDABARI_SERVICE=myapp ./install.sh" >&2
  exit 1
fi
SERVICE_NAME="$SIDABARI_SERVICE"

# --- 1. 진단 전용 공개키 확인 ---
PUB_KEY_FILE="$HERE/sidabari-diag.pub"
if [ ! -f "$PUB_KEY_FILE" ]; then
  echo "[ERROR] $PUB_KEY_FILE 가 없습니다."
  echo "        로컬에서 ssh-keygen -t ed25519 -f ~/.ssh/sidabari-diag -N \"\" -C sidabari-diagnostic 후"
  echo "        ~/.ssh/sidabari-diag.pub 을 이 디렉토리로 업로드하세요."
  exit 1
fi
PUB_KEY_LINE="$(tr -d '\r\n' < "$PUB_KEY_FILE")"
if [ -z "$PUB_KEY_LINE" ]; then
  echo "[ERROR] 공개키가 비어 있습니다: $PUB_KEY_FILE"
  exit 1
fi

# --- 2. sidabari-collect.sh 확인 + 설치 ---
SCRIPT_SRC="$HERE/sidabari-collect.sh"
if [ ! -f "$SCRIPT_SRC" ]; then
  echo "[ERROR] $SCRIPT_SRC 가 없습니다."
  exit 1
fi

echo "[1/4] /usr/local/bin/sidabari-collect 설치 중 (서비스: $SERVICE_NAME)..."
sudo install -o root -g root -m 0755 "$SCRIPT_SRC" /usr/local/bin/sidabari-collect

# 서비스명을 환경변수로 박아두기 (스크립트는 SIDABARI_SERVICE 우선 참조)
sudo tee /etc/default/sidabari-collect > /dev/null <<EOF
SIDABARI_SERVICE=$SERVICE_NAME
EOF
sudo chmod 0644 /etc/default/sidabari-collect

# --- 3. sudoers — JVM 진단에 필요한 최소 권한만 NOPASSWD ---
echo "[2/4] sudoers 화이트리스트 설치 중..."
TMP_SUDOERS="$(mktemp)"
cat > "$TMP_SUDOERS" <<'EOF'
# Sidabari 진단 — JVM 명령에 한해 NOPASSWD 허용.
# Cmnd_Alias로 정확 명령만 허용 (와일드카드 인자 우회 위험을 줄이기 위해 jstack/jcmd/jstat만).
# 이 사용자가 어떤 SSH로 들어와도 ForceCommand로 sidabari-collect만 도므로 sudo 호출은 그 안에서만 발생.
Cmnd_Alias SIDABARI_DIAG = \
  /usr/bin/nsenter -t [0-9]* -m -- /usr/bin/jstack [0-9]*, \
  /usr/bin/nsenter -t [0-9]* -m -- /usr/bin/jcmd [0-9]* *, \
  /usr/bin/jstat -gc [0-9]* *, \
  /usr/bin/jstat -gcutil [0-9]* *

%sidabari-diag-users ALL=(root) NOPASSWD: SIDABARI_DIAG
EOF
sudo install -o root -g root -m 0440 "$TMP_SUDOERS" /etc/sudoers.d/sidabari-diag
sudo visudo -c -f /etc/sudoers.d/sidabari-diag
rm -f "$TMP_SUDOERS"

# 현재 사용자(ec2-user 등)를 sidabari-diag-users 그룹에 추가
echo "[3/4] sidabari-diag-users 그룹 + 현재 사용자 가입 중..."
if ! getent group sidabari-diag-users > /dev/null; then
  sudo groupadd sidabari-diag-users
fi
sudo usermod -a -G sidabari-diag-users "$USER"

# --- 4. authorized_keys에 ForceCommand 진단 키 추가 ---
echo "[4/4] ~/.ssh/authorized_keys에 ForceCommand 진단 키 등록 중..."
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

FORCED_LINE='command="/usr/local/bin/sidabari-collect",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,restrict '"$PUB_KEY_LINE"

# 동일 공개키가 이미 등록되어 있으면 그 라인을 교체, 없으면 추가
KEY_BODY="$(awk '{print $2}' "$PUB_KEY_FILE" | head -n1)"
if [ -n "$KEY_BODY" ] && grep -q "$KEY_BODY" ~/.ssh/authorized_keys; then
  # 임시 파일에 키 본문이 안 들어간 라인만 옮긴 뒤, 강제 명령 라인 한 줄 추가
  TMP_AUTH="$(mktemp)"
  grep -v "$KEY_BODY" ~/.ssh/authorized_keys > "$TMP_AUTH" || true
  echo "$FORCED_LINE" >> "$TMP_AUTH"
  install -m 0600 "$TMP_AUTH" ~/.ssh/authorized_keys
  rm -f "$TMP_AUTH"
  echo "   기존 등록 갱신."
else
  echo "$FORCED_LINE" >> ~/.ssh/authorized_keys
  echo "   신규 등록."
fi

# --- 검증 ---
echo ""
echo "===== 셋업 완료. 확인 사항 ====="
echo "1. 그룹 변경은 새 SSH 세션부터 적용됩니다. (현재 세션 빠져나갔다 다시 접속)"
echo "2. 다음을 클라이언트(로컬 PC)에서 실행해 동작 확인:"
echo "     ssh -i ~/.ssh/sidabari-diag $USER@$(hostname -I | awk '{print $1}') 'rm -rf /'"
echo "   → 'rm -rf /'는 무시되고 sidabari-collect 출력만 보여야 정상."
echo "3. Sidabari 설정 모달의 [진단 전용 키 경로]에 ~/.ssh/sidabari-diag (private)를 등록."
echo "   ※ private key — pub 파일 X."
