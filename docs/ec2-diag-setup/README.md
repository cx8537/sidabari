# EC2 진단 안전장치 셋업 가이드

Sidabari의 [시스템 데이터 수집] 버튼은 메인 Claude Code에게 **진단 전용 SSH 키**로 EC2 접속을 위임한다. 이 키는 서버 측 OpenSSH `ForceCommand`로 잠겨 있어, **누가 어떤 명령을 보내든 정해진 진단 스크립트만 실행되고 끊긴다.** 따라서 진단 키가 통째로 유출돼도, 또는 Claude가 의도치 않게 위험한 명령을 시도해도, 시스템 변경은 물리적으로 불가능하다.

이 디렉토리에는 그 셋업에 필요한 파일이 들어 있다.

## 무엇이 보장되는가

- **시스템 변경 불가**: 진단 키로 SSH가 들어오면 sshd가 사용자 명령(`SSH_ORIGINAL_COMMAND`)을 무시하고 `/usr/local/bin/sidabari-collect`만 실행. 그 외 모든 명령은 실행되지 않는다.
- **포트 포워딩 차단**: `no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,restrict` 옵션으로 우회 채널 모두 봉쇄.
- **scp/sftp 차단**: ForceCommand가 sftp 서브시스템도 가로챈다.
- **JVM 진단도 sudo 화이트리스트로 최소화**: `nsenter+jstack/jcmd`, `jstat` 만 NOPASSWD 허용. 그 외 sudo는 모두 비밀번호 또는 거부.
- **배포용 키와 분리**: 기존 `.pem`(전체 권한)은 Sidabari 자체의 SSH 채널(빌드/배포)에서만 쓴다. Claude는 진단 키만 손에 쥔다.

## 셋업 절차

### 1단계 — 로컬에서 진단 전용 키페어 생성

```bash
# 로컬(예: 본인 Windows의 git-bash 또는 WSL)에서:
ssh-keygen -t ed25519 -f ~/.ssh/sidabari-diag -N "" -C sidabari-diagnostic
```

이렇게 하면 두 파일이 만들어진다:

- `~/.ssh/sidabari-diag` (private key, **이걸 Sidabari에 등록**)
- `~/.ssh/sidabari-diag.pub` (public key, EC2에 업로드)

### 2단계 — 셋업 파일을 EC2에 업로드

이 디렉토리(`docs/ec2-diag-setup`)의 파일들과 방금 만든 `sidabari-diag.pub`을 EC2의 임시 폴더로 복사한다. 예시:

```bash
# 로컬에서:
scp -i <기존_배포용_pem> \
  docs/ec2-diag-setup/install.sh \
  docs/ec2-diag-setup/sidabari-collect.sh \
  ~/.ssh/sidabari-diag.pub \
  ec2-user@<HOST>:/tmp/sidabari-diag-setup/
```

(폴더가 없으면 `ssh ec2-user@<HOST> 'mkdir -p /tmp/sidabari-diag-setup'` 먼저)

### 3단계 — EC2에서 install.sh 실행

```bash
# 로컬에서:
ssh -i <기존_배포용_pem> ec2-user@<HOST>
# 이제 EC2 안:
cd /tmp/sidabari-diag-setup
chmod +x install.sh sidabari-collect.sh
./install.sh
```

스크립트가 다음을 처리한다:

1. `/usr/local/bin/sidabari-collect` 설치 (root 소유, 0755)
2. `/etc/default/sidabari-collect`에 서비스명 기록 (`SIDABARI_SERVICE=***REDACTED-SERVICE***`)
3. `/etc/sudoers.d/sidabari-diag` — JVM 명령만 NOPASSWD 허용
4. `sidabari-diag-users` 그룹 생성 + 현재 사용자 추가
5. `~/.ssh/authorized_keys`에 ForceCommand 잠금으로 진단 공개키 등록

**주의**: 그룹 변경은 새 SSH 세션부터 적용. 한 번 SSH 끊었다가 다시 들어와야 sudo 화이트리스트가 활성화된다.

### 4단계 — 동작 확인

로컬에서:

```bash
# 다음 두 명령은 결과가 똑같아야 한다 (서버가 사용자 명령을 무시함을 확인):
ssh -i ~/.ssh/sidabari-diag ec2-user@<HOST> 'whoami'
ssh -i ~/.ssh/sidabari-diag ec2-user@<HOST> 'rm -rf /'
ssh -i ~/.ssh/sidabari-diag ec2-user@<HOST> 'sudo systemctl stop ***REDACTED-SERVICE***'
```

세 명령 모두 진단 스크립트(`===== 자료 일괄 수집 ... =====`) 출력만 나오고 끊겨야 정상.

### 5단계 — Sidabari 설정 모달에 등록

설정 → **Claude 시스템 진단 안전장치** 섹션:

- **진단 전용 키 경로**: 1단계에서 만든 `private key` 파일 경로 선택
  - 예 Windows: `C:\Users\<you>\.ssh\sidabari-diag`
  - 예 Linux/Mac: `/home/<you>/.ssh/sidabari-diag`
  - **public key(.pub) 아닙니다.**
- **로컬 보조 방어선** → [안전 규칙 설치] 클릭 (보조 방어선)

저장 후 메인 Claude Code 패널의 [시스템 데이터 수집] 버튼이 활성화된다.

## 위협 모델 / 한계

이 셋업이 **막아주는 것**:

- Claude가 ssh로 임의 명령을 보내려는 시도 (서버가 무시).
- Claude가 scp/sftp로 파일을 올리려는 시도 (ForceCommand가 sftp 서브시스템도 가로챔).
- 진단 키 유출 시 공격자의 시스템 변경 시도 (마찬가지로 무시됨).

이 셋업이 **막지 못하는 것**:

- **배포용 .pem 자체가 유출되는 경우** — 이건 별도 키 보호 문제. Sidabari는 .pem 경로만 들고 내용은 OS 파일권한으로 지켜진다고 가정.
- **EC2 자체에 다른 침입 경로가 있는 경우** — 이 셋업의 범위 밖.
- **sidabari-collect 스크립트 자체가 root에 의해 변경되는 경우** — 그 시점에는 이미 시스템 권한이 손상된 상황.
- **로컬 Claude Code가 ssh 외 다른 경로로 EC2에 접근**(예: 외부 API 호출, 다른 키로 ssh) — 이 부분은 Sidabari 설정 모달의 [안전 규칙 설치]가 보조 방어선으로 막는다(단, 패턴 매칭이라 우회 가능 — 의존하지 말 것).

## 셋업 변경/제거

- 진단 비활성화: `~/.ssh/authorized_keys`에서 `sidabari-diag` 라인 제거.
- 스크립트 갱신(예: 명령 추가): 로컬에서 `sidabari-collect.sh` 수정 후 EC2에 재업로드, `sudo install -o root -g root -m 0755 sidabari-collect.sh /usr/local/bin/sidabari-collect`.
- 서비스명 변경: `/etc/default/sidabari-collect` 의 `SIDABARI_SERVICE` 갱신.

## 트러블슈팅

**Q. ssh 시 비밀번호를 물어본다 / Permission denied (publickey)**
- 진단 키 권한 확인: `chmod 600 ~/.ssh/sidabari-diag`
- EC2의 `~/.ssh/authorized_keys` 권한: 600, `~/.ssh`: 700.
- `~/.ssh/authorized_keys`에 진단 키 라인이 들어있고 그 앞에 `command="..."`이 붙어있는지 `cat`으로 확인.

**Q. jstack/jcmd 출력이 비어있다**
- `sudo nsenter ...` 가 화이트리스트에 정확히 매칭되는지 확인. 한 번 SSH 끊었다 다시 접속해 그룹 적용 확인.
- 서비스 PID가 0이거나 비어있으면 systemd가 아직 서비스를 모름. `systemctl status <서비스>`로 상태 점검.

**Q. install.sh가 visudo -c 에서 실패한다**
- sudoers 문법 오류. 스크립트가 자동 검증하니, 실패 시 `/etc/sudoers.d/sidabari-diag`를 즉시 제거하고 다시 시도. 절대 잘못된 sudoers를 남기지 말 것.

**Q. ForceCommand가 잘 적용됐는지 한 번 더 확인하고 싶다**
- 서버에서: `cat ~/.ssh/authorized_keys | grep sidabari` → 라인 시작에 `command="/usr/local/bin/sidabari-collect",no-...,restrict`가 붙어있어야 함.
- 클라이언트에서 임의 명령을 보냈을 때 진단 출력만 나와야 함.
