# Sidabari 프로젝트 사양서

> **프로젝트명**: Sidabari (저장소/패키지/코드 식별자)
> **표시명**: 또돌이 (기본값, 사용자 변경 가능)
> **목적**: Claude Code 기반 바이브 코딩에서 발생하는 반복적 배포-진단-수정 사이클을 자동화하는 본인용 도구

---

## 1. 프로젝트 개요

### 1.1 배경

Claude Code로 코드 작성 → 빌드 → AWS EC2 배포 → 로그 확인 → 에러 추적 → 코드 수정으로 이어지는 반복 사이클이 모두 사람의 수작업으로 이루어지고 있다. 특히 PuTTY로 EC2에 접속해 명령을 실행하고 콘솔 출력을 다시 Claude Code에 전달하는 왕복 노가다가 빈번하다. 이 도구는 그 기계적 반복 작업을 자동화한다.

### 1.2 핵심 자동화 철학

- **기계적 작업은 자동화, 판단은 사람이.**
- 빌드, 업로드, 스크립트 실행 등 반복적이고 기계적인 작업은 도구가 자동 수행.
- 분석, 진단, 수정 결정 같은 판단이 필요한 작업은 항상 사람이 한다.
- Claude는 분석과 추천만 제공하며, 명령 실행은 사람이 결정한다.
- **자동 재시도 금지.** 실패 시 멈추고 사람이 판단한다.

### 1.3 사용자

본인 1명 (혼자 사용). 범용 도구가 아니므로 룰 엔진 등 일반화 메커니즘 불필요. 동작은 코드에 직접 정의.

---

## 2. 기술 스택

### 앱 셸
- **Tauri 2.x** (멀티 윈도우 지원)

### 프론트엔드
- **Vite + React 18+ + TypeScript**
- **Tailwind CSS**, **shadcn/ui**, **lucide-react**
- **xterm.js + xterm-addon-fit** (터미널 렌더링)
- **react-resizable-panels** (패널 분할/크기 조절)
- **Zustand** (상태 관리)

### 백엔드 (Rust)
- **Tauri Core** (IPC)
- **tokio** (async 런타임)
- **portable-pty** (로컬 pty: Claude Code 인스턴스)
- **russh** (SSH/SFTP 클라이언트)
- **serde + serde_json** (설정 파일)
- **notify** (파일 시스템 감시)
- **regex** (ERROR 패턴 매칭)
- **chrono** (시각 처리)
- **tracing** (로깅)
- **rusqlite** (이벤트 로그 영구화, 선택)

---

## 3. 워크플로우 설계

### 3.1 Attempt 모델

한 번의 시도(Attempt)가 자동화의 기본 단위.

- **시작**: 사용자가 "시도 시작" 버튼을 명시적으로 클릭한 시점
- **원자적**: 한 번 시작되면 변경 불가능
- **자동 트리거 없음**: 파일 변경 자동 감지 같은 메커니즘 없음
- **일시정지/재개 없음**: 강제 중단만 가능

### 3.2 배포 사이클

```
[0] 사전 점검
    ├─ 작업 디렉토리 상태 확인 (커밋 여부, 빌드 캐시 등)
    └─ 환경 점검 (SSH 접속, 디스크 여유, 동시 배포 충돌)
    → 자동 진행, 문제 시 즉시 멈춤

[1] 빌드
    ├─ 사용자 정의 빌드 명령 실행 (예: build.bat, ./gradlew build)
    ├─ stdout/stderr 캡처
    └─ exit code로 성공/실패 판단

[2] jar 업로드
    ├─ SFTP로 EC2 홈 디렉토리에 전송
    └─ 실패 시 즉시 멈춤

[3] deploy.sh 실행
    ├─ 스크립트가 종료+교체+시작+기동 확인까지 일체로 처리
    ├─ stdout/stderr 캡처
    └─ exit code로 성공 여부 판단 (실패 시 진단 루프 가능)

[4] 로그 모니터링 + 에러 감지
    ├─ journalctl 또는 로그 파일 follow
    └─ ERROR 패턴 등장 시 진단 루프 진입
```

### 3.3 진단 루프 (에러 발생 시)

```
[D1] 진단 세션 시작
    ├─ 진단 전용 SSH 세션 오픈 (메인과 분리)
    └─ 에러 컨텍스트 자동 수집

[D2] 1차 분석 요청 (Claude)
    └─ 컨텍스트 → 좌측 메인 Claude Code 입력창에 주입 (사용자가 Enter)

[D3] 명령 선택 및 실행 (사람)
    ├─ Claude 추천 명령 또는 진단 명령 라이브러리에서 선택
    └─ 사용자가 실행 결정

[D4] 결과 분석 (Claude)
    └─ 명령 출력을 Claude에 전달, 가설 검증/갱신

[D5] 분기 결정 (사람)
    ├─ 추가 조사 필요 → D3로 반복
    ├─ 원인 명확 → D6
    ├─ 보류 → ABANDONED
    └─ 포기 → ABANDONED

[D6] 해결 방안 결정 (사람)
    ├─ 코드 수정 / 설정 변경 / 인프라 조치
    └─ Attempt 종료, 사용자가 새 Attempt 시작
```

### 3.4 Attempt 종료 상태

| 상태 | 트리거 | 후속 |
|------|--------|------|
| `SUCCESS` | 사용자 "성공" 클릭 | 자동화 종료 |
| `FAILED_INFRA` | 자동 감지 (SSH 끊김 / 타임아웃 / 예외) | 사용자가 환경 복구 후 재시작 |
| `FAILED_APP_NEEDS_FIX` | 진단 루프 결론 | 사용자가 수정 후 새 Attempt |
| `ABANDONED` | 진단 보류/포기 | 사용자 판단 |
| `USER_ABORTED` | 사용자 강제 중단 | 사용자가 환경 정리 |

### 3.5 에러 감지 기준

**Log4j2 `[ERROR]` 패턴 단일 기준.**

- 화이트리스트 없음. 모든 ERROR가 대응 대상.
- 노이즈성 ERROR도 자동화가 매번 멈추므로, 자연스럽게 적절한 레벨로 정정하게 됨.

**에러 묶음 정의:**

- 시작점: `[ERROR]` 패턴 등장한 줄
- 포함:
  - 시작 줄 + 예외 클래스 + 메시지
  - `at ...` 스택 프레임들
  - `Caused by:` 체인 (있는 만큼 모두) **← 필수**
  - `Suppressed:` 절 (있으면)
  - `... N more` 같은 생략 표시
- 종료 조건: 새로운 로그 레벨 등장 또는 5초간 추가 출력 없음

### 3.6 Claude에 전달할 컨텍스트

**시점 A: 첫 분석 요청 (D2)**

- 에러 묶음 전체 (스택 + Caused by 체인 + Suppressed 모두)
- 에러 직전 30줄
- 에러 직후 10줄 (5초 대기 후 캡처)
- git 정보는 자동 첨부하지 않음 (Claude Code가 직접 확인)

**시점 B: 진단 명령 결과 (D4)**

- 실행한 명령 + 출력 (전체 또는 N줄 제한)
- 이전 컨텍스트는 Claude Code 대화 히스토리에 의존 (재전송 안 함)

**전달 형식:**

- 좌측 메인 Claude Code 입력창에 텍스트 주입 (Ctrl+V 효과)
- 기본은 자동 전송, 옵션으로 편집 후 전송 가능

### 3.7 안전 정책

- **SSH 끊김**: 10초 이내 자동 복구는 무시, 초과 시 `FAILED_INFRA`
- **자동 재시도 금지**: 모든 재시도는 사용자가 새 Attempt로 결정
- **강제 중단**: 진행 중 명령에 Ctrl+C 전송, **SSH 채널은 유지** (사용자가 같은 세션에서 수작업 이어받음)
- **임의의 단계에서 문제 발견 시 즉시 정지**하고 사용자에게 알림
- **Claude는 분석/추천만**, 명령 실행은 항상 사용자 승인

---

## 4. UI 설계

### 4.1 화면 레이아웃

```
┌─[icon]─ 메인 툴바: [시도 시작] [강제 중단] ───────────[×]┐
│   [중앙상단 탭바: 탭1, 탭2, +]                          │
├──────────┬──────────────────────────┬──────────────────┤
│          │                          │                  │
│  좌측    │   중앙 상단              │   우측           │
│  메인    │   추가 Claude Code들     │   도구 콘솔      │
│  Claude  │   (탭으로 관리)          │   로그           │
│  Code    │                          │                  │
│ (작업    ├───────────┬──────────────┤                  │
│  지시용) │           │              │                  │
│          │ EC2 #1    │ EC2 #2       │                  │
│          │ (메인)    │ (진단)       │                  │
│          │ [툴바]    │ [툴바]       │                  │
└──────────┴───────────┴──────────────┴──────────────────┘
```

### 4.2 영역별 역할

- **좌측 (메인 Claude Code)**: 사용자가 직접 코드 작성 지시. 'Claude에 분석 요청' 시 텍스트가 여기 입력창에 주입됨.
- **중앙 상단 (추가 Claude Code 탭들)**: 디렉토리 경로 입력 → `claude -c`로 실행. 멀티 작업용.
- **중앙 하단 (EC2 SSH 터미널들)**: 메인 SSH (deploy.sh, 로그 모니터링) + 진단 SSH (조사 명령).
- **우측 (도구 콘솔 로그)**: 도구 동작을 시간순으로 표시. 워크플로우 진행 + 도구 자체 진단.

### 4.3 패널 동작

- 모든 패널 경계 드래그로 크기 조절
- 모든 패널 플로팅 가능 (별도 윈도우, 다중 모니터 지원)
- 중앙 상단 탭은 영역 통째 또는 개별 탭 단위로 플로팅
- 플로팅된 창에서도 새 탭 추가 가능, 메인 창으로 다시 도킹 가능
- **UI 모듈화 필수**: 패널 단위 독립 컴포넌트, 어디 위치하든 동일 동작
- 플로팅 비활성화 시 '닫기' 버튼만 제거하여 대응

### 4.4 툴바

**메인 툴바 (화면 상단)**:
- `[시도 시작]`: 새 Attempt 트리거
- `[강제 중단]`: 진행 중 Attempt 즉시 중단 (Ctrl+C 전송, SSH 채널 유지)
- 단축키 지원

**EC2 패널별 툴바**:
- `[Claude에 분석 요청]` 버튼
- 클릭 시: 컨텍스트 텍스트가 좌측 메인 Claude Code 입력창에 주입됨 (Ctrl+V 효과)
- 사용자가 내용 확인/편집 후 Enter로 전송
- **별도의 Claude 채팅 UI를 만들지 않음.** Claude Code의 입력창을 그대로 활용

### 4.5 모달 (의사결정 게이트)

판단이 필요한 시점에 모달 팝업 표시.

- **ERROR 감지 시 모달은 자동으로 뜨지 않음.** 사용자가 EC2 툴바의 '분석 요청' 버튼을 누를 때만 표시
- 모달이 뜨면 명확하게 흐름이 멈춰 결정을 유도
- 적용 시점: Claude 분석 요청, 진단 명령 실행, 분기 결정 등

### 4.6 우측 콘솔 로그

워크플로우 상태 표시는 별도 만들지 않고 콘솔 로그로 갈음.

- 시간순 표시
- 워크플로우 이벤트 + 사용자 액션 + 도구 자체 상태 모두 한 곳에
- "진행 중" vs "완료" 상태가 로그 포맷으로 명확히 구분되어야 함
- 예시:
  ```
  [11:23:00] [BUILD] 시작
  [11:23:45] [BUILD] 완료 (exit=0)
  [11:23:46] [UPLOAD] 시작
  [11:24:10] [UPLOAD] 완료 (12.3MB, 24s)
  [11:24:11] [DEPLOY] 진행 중...
  [11:25:30] [MONITOR] ERROR 감지
  [11:25:31] [USER] 분석 요청 클릭
  ```

---

## 5. 설정

### 5.1 정책

- **한 도구 인스턴스 = 한 프로젝트**
- **JSON 파일**로 저장
- **OS 표준 위치** 사용 (Tauri의 path API)
  - macOS: `~/Library/Application Support/sidabari/config.json`
  - Windows: `%APPDATA%\sidabari\config.json`
  - Linux: `~/.config/sidabari/config.json`
- 재시작 시 설정에 따라 Claude Code 자동 실행, EC2 자동 접속
- **pem 키 파일은 경로만 저장** (파일 자체는 외부 보관)
- 설정 UI는 별도 모달 또는 별도 윈도우

### 5.2 설정 파일 스키마 (참고)

```json
{
  "schema_version": 1,
  "display_name": "또돌이",

  "project": {
    "name": "myapp"
  },

  "claude_code_sessions": {
    "main": {
      "label": "메인 (백엔드)",
      "directory": "/Users/me/projects/myapp-backend",
      "auto_start": true
    },
    "additional": [
      {
        "label": "프론트엔드",
        "directory": "/Users/me/projects/myapp-frontend"
      }
    ]
  },

  "ec2": {
    "host": "ec2-xxx.compute.amazonaws.com",
    "port": 22,
    "user": "ubuntu",
    "private_key_path": "/Users/me/.ssh/myapp-key.pem"
  },

  "sftp": {
    "use_same_as_ssh": true,
    "remote_upload_path": "/home/ubuntu"
  },

  "deploy": {
    "build_command": "build.bat",
    "build_working_directory": "C:\\projects\\myapp",
    "jar_output_path": "build/libs/myapp.jar",
    "build_timeout_seconds": 300,
    "deploy_script": "./deploy.sh",
    "restart_script": "./restart.sh",
    "stop_script": "./stop.sh"
  },

  "monitoring": {
    "log_command": "journalctl -u myapp -f",
    "error_pattern": "\\[ERROR\\]",
    "context_lines_before": 30,
    "context_lines_after": 10,
    "context_capture_delay_seconds": 5
  },

  "safety": {
    "ssh_disconnect_grace_seconds": 10
  }
}
```

---

## 6. 구현 우선순위

### 6.1 1단계: UI + Mock 데이터

목표: 사용성 검증

- Tauri + Vite + React + TypeScript 프로젝트 셋업
- 전체 레이아웃 구현 (4영역)
- 패널 분할/크기 조절/플로팅 동작
- 메인 툴바 + EC2 패널 툴바
- 모달 다이얼로그 (의사결정 게이트)
- 설정 UI
- xterm.js로 터미널 영역 렌더링 (Mock 데이터로 출력 시뮬레이션)
- 사용성 검증 후 다음 단계로

### 6.2 2단계: Rust 백엔드 점진 통합

기능별로 하나씩 통합, 각 단계마다 동작 확인.

1. 설정 파일 로드/저장 (serde_json)
2. 로컬 pty 관리 (portable-pty) - Claude Code 인스턴스 실행/IO
3. SSH/SFTP 연결 (russh)
4. 빌드/배포 명령 실행 + 출력 캡처
5. ERROR 패턴 감지 (regex)
6. 워크플로우 상태머신 (Attempt 생명주기)
7. 이벤트 로그 영구화 (선택: rusqlite)

---

## 7. 참고 - 본인의 현재 작업 흐름

도구 설계의 배경 맥락:

```
[Claude Code] 코드 작성/수정 (수동 지시)
    ↓
[로컬 빌드] build.bat 수동 실행
    ↓
[WinSCP] jar 파일을 EC2 홈에 업로드 (수동)
    ↓
[PuTTY] EC2에 SSH 접속, 홈 디렉토리에서 ./deploy.sh 실행
    ↓
[로그 확인] 콘솔에서 직접 모니터링
    ↓
[에러 발견] 로그 복사 → Claude Code에 붙여넣기 (수동)
    ↓
[원인 조사] 추가 명령 (ps, df, netstat 등)을 PuTTY에서 수동 실행
    ↓
[코드 수정] Claude Code에 지시
    ↓ (사이클 반복)
```

**기존 자산:**

- `deploy.sh`: 종료 + jar 교체(.backup으로 백업) + 서비스 시작 + 정상 기동 확인. 실패 시 콘솔에 에러 출력. EC2 홈 디렉토리에 위치.
- `restart.sh`: 재시작만 (파일 수정 없음)
- `stop.sh`: 종료만
- 빌드 배치 스크립트(build.bat): 로컬에 존재
