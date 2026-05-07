# Sidabari

> **1인용 Claude Code 바이브 코딩 자동화 도구**
>
> Claude Code로 코드를 작성하고 AWS EC2에 배포·진단·수정하는 반복 사이클을 한 화면에서 처리하기 위한 데스크톱 도구.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows_11-0078D6?style=flat-square&logo=windows11&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)

---

## 무엇을 해 주는가

Claude Code → 빌드 → SFTP 업로드 → `deploy.sh` → 로그 모니터링 → ERROR 감지 → 진단 → Claude에 분석 요청, 이 사이클의 **기계적인 부분만** 자동화합니다. 분석·진단·수정 결정은 항상 사람이 합니다.

핵심 철학:

- **기계적 작업은 자동화, 판단은 사람.** Claude는 분석·추천만, 실행은 사람이 결정.
- **자동 재시도 금지.** 실패 시 즉시 멈추고 사람이 판단.
- **강제 중단 시 SSH 채널은 유지.** 같은 세션에서 수작업으로 이어받기.

자세한 동작 사양은 [SIDABARI_SPEC.md](SIDABARI_SPEC.md), 작업 규칙·보안 정책은 [CLAUDE.md](CLAUDE.md)를 참고하세요.

---

## 사용 대상

처음부터 본인 1명 사용을 가정하고 만든 도구입니다. 같은 워크플로우 — **Claude Code로 코딩 → JVM/Spring Boot 같은 백엔드를 AWS EC2(systemd)에 SFTP로 올려 `deploy.sh` 재기동 → journalctl 로그 모니터링 → ERROR 진단** — 을 쓰는 다른 분이라면 그대로 쓰거나 포크해 본인 환경에 맞게 손보실 수 있습니다. MIT 라이선스로 공개합니다.

룰 엔진 같은 일반화 메커니즘은 일부러 두지 않았습니다. 동작이 코드에 직접 정의되어 있어 본인 워크플로우에 맞춘 변경이 오히려 쉬운 편입니다 (사양서 §1.3 참조).

---

## 주요 기능

- **4영역 패널 레이아웃** (좌: 메인 Claude / 중상: 추가 Claude 탭 / 중하: EC2 SSH 메인+진단 / 우: 도구 콘솔). 분할·플로팅·도킹 지원.
- **로컬 PTY로 Claude Code 인스턴스 실행** (`portable-pty` + ConPTY/Unix PTY 추상).
- **SSH/SFTP 메인+진단 채널 분리** (`russh`, 호스트키 TOFU 검증).
- **빌드 → 업로드 → 배포 자동 실행** + 단계별 강제 중단 (Ctrl+C 전송, 채널 유지).
- **ERROR 자동 감지** (Log4j2 `[ERROR]` + `Caused by` 전체 체인).
- **EC2 진단 패널 [자료 일괄 수집]** + **시스템 진단 대시보드** (1분 자동갱신 토글).
- **진단 전용 SSH 키 + 서버 ForceCommand** 패턴으로 Claude의 자율 진단을 안전하게 (시스템 변경 물리적으로 불가능).
- **Claude Code 훅 통합** (Stop/Pre/PostToolUse/Notification/SessionStart) — 패널별 활성도/도구 가시화, 데스크톱 알림, 위험 도구 게이트, 감사 로그(SQLite).
- **Tauri command 검증** + `permissions.deny > permissions.allow` + autoMode 분류기 통합.

---

## 기술 스택

### 앱 셸

![Tauri](https://img.shields.io/badge/Tauri_2.x-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)

### 프론트엔드

![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-000000?style=for-the-badge&logo=shadcnui&logoColor=white)
![Zustand](https://img.shields.io/badge/Zustand-443E38?style=for-the-badge)
![Zod](https://img.shields.io/badge/Zod-3068B7?style=for-the-badge&logo=zod&logoColor=white)
![Lucide](https://img.shields.io/badge/Lucide_Icons-F56565?style=for-the-badge&logo=lucide&logoColor=white)

추가 라이브러리: xterm.js v6, react-resizable-panels, react-rnd, @fontsource-variable/geist, @tauri-apps/api · plugin-clipboard-manager · plugin-dialog · plugin-notification · plugin-window-state.

### 백엔드 (Rust)

![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![Tokio](https://img.shields.io/badge/Tokio-B22222?style=for-the-badge)
![SQLite](https://img.shields.io/badge/SQLite_(rusqlite_bundled)-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

추가 crate: portable-pty, russh · russh-keys · russh-sftp, serde · serde_json, notify, ssh-key (ed25519), rand_core, sha2, async-trait, uuid.

---

## 사전 준비

- **Node.js**: 20 이상 권장 (개발에 24.x 검증됨)
- **Rust toolchain**: stable (`rustup` 권장). Windows는 MSVC 빌드 도구 + WebView2.
- **OS**: 1차 검증은 Windows 11. macOS/Linux는 코드상 호환되나 미검증.
- **Claude Code CLI**: `claude` 명령이 PATH에 있어야 메인/추가 Claude 패널에서 자동 spawn 가능.
- **EC2**: SSH 접속 가능한 인스턴스 + (선택) 진단 전용 키 설치를 위한 sudo 권한.

---

## 개발 셋업

```sh
# 1) 의존성 설치
npm install

# 2) Rust + WebView2 등 Tauri 사전 요구사항 점검
npx @tauri-apps/cli info

# 3) 개발 모드 실행 (vite dev + Rust 컴파일 + Tauri 윈도우)
npm run tauri dev
```

빠른 빌드 확인만 필요하면:

```sh
npm run build      # tsc + vite 프론트엔드 빌드
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 빌드 (배포 산출물)

```sh
npm run tauri build
```

산출물 위치 (Windows 기준):

- `src-tauri/target/release/sidabari.exe` — 단일 실행파일
- `src-tauri/target/release/bundle/` — MSI / NSIS 인스톨러

---

## 프로젝트 구조

```
Sidabari/
├── src/                       # React 프론트엔드
│   ├── components/
│   │   ├── layout/            # MainLayout, MainToolbar
│   │   ├── panels/            # 4영역 패널 컴포넌트
│   │   ├── terminal/          # PtyTerminal, SshTerminal (xterm 래퍼)
│   │   ├── modals/            # SettingsModal, GateModal, DiagSetupModal
│   │   ├── monitor/           # HookBridge (Claude Code 훅 미러링)
│   │   └── dashboard/         # DiagnosticDashboard
│   ├── lib/                   # ssh, pty, config, parseDiagnostic 등 IPC 래퍼
│   └── store/                 # Zustand 전역 상태
├── src-tauri/                 # Rust 백엔드
│   └── src/
│       ├── pty.rs             # 로컬 PTY (portable-pty)
│       ├── ssh.rs             # SSH 셸 (russh)
│       ├── ssh_exec.rs        # SSH exec / 헤드리스 collect
│       ├── sftp.rs            # SFTP 업로드 (sha256 검증)
│       ├── build.rs           # 로컬 빌드 명령 spawn
│       ├── config.rs          # 설정 load/save (TOML)
│       ├── hooks_bus.rs       # Claude Code 훅 IPC (events.jsonl + req/resp)
│       ├── audit_log.rs       # SQLite 감사 로그
│       ├── claude_safety.rs   # .claude/settings.local.json deny 규칙
│       ├── diag_setup.rs      # 원클릭 진단 키페어 + ForceCommand 셋업
│       └── diag_ssh_allow.rs  # autoMode allow 패턴 등록
├── docs/
│   └── ec2-diag-setup/        # 서버 측 install.sh, sidabari-collect.sh
├── branding/
│   └── sidabari-icon-source.png  # 아이콘 원본 (1024×1024)
├── CLAUDE.md                  # 작업 절대 원칙 + 보안 가이드 + UI 가이드
├── SIDABARI_SPEC.md           # 동작 사양서
└── README.md
```

---

## 설정

- 위치 (OS 표준):
  - Windows: `%APPDATA%\sidabari\sidabari.toml`
  - macOS: `~/Library/Application Support/sidabari/sidabari.toml`
  - Linux: `~/.config/sidabari/sidabari.toml`
- 앱 내 [설정] 모달에서 편집 (탭: 일반 / 서버 / 빌드·배포 / 모니터링 / 시스템 진단).
- **PEM 키는 경로만 저장** — 키 내용은 메모리에만 로드. 로그에 자격증명 안 찍힘.
- 설정 변경 후 [재시작] 또는 자동 재시작 토글로 모든 Claude PTY 일괄 재시작 (`.claude/settings.local.json` 즉시 반영).

스키마 레퍼런스는 [SIDABARI_SPEC.md §5.2](SIDABARI_SPEC.md#52-설정-파일-스키마-참고), 코드는 `src-tauri/src/config.rs` / `src/lib/config.ts`.

---

## EC2 진단 셋업 (선택)

진단 전용 SSH 키 + 서버 측 `ForceCommand`로 잠근 채널을 만들면, Claude의 [시스템 데이터 수집] 명령이 자율적으로 SSH 접속해 진단 자료를 수집해도 시스템 변경이 **물리적으로 불가능**합니다.

앱의 [설정] → [시스템 진단] → **[원클릭 진단 셋업]** 버튼으로 일괄 처리:

1. 로컬에 `~/.ssh/sidabari-diag` ed25519 키페어 생성/재사용
2. SFTP로 서버에 `install.sh` + `sidabari-collect.sh` 업로드
3. 서버에서 sudoers / sshd `Match User` / `authorized_keys` `command="..."` 자동 구성

세부 동작은 [docs/ec2-diag-setup/README.md](docs/ec2-diag-setup/README.md) 참조.

---

## 보안 정책 요약

- 자격증명/키 파일 내용은 **메모리에만**, 로그·설정·DB에 안 들어감.
- 사용자 입력을 셸 명령 문자열로 직접 조합하지 않음 (러시 구조화 API 사용).
- SSH 호스트 키 TOFU 검증 (자동 수락 모드 X).
- Tauri command 입력 검증 + 위험 도구 게이트 모달.
- 감사 로그 (SQLite) 권한 `0600`.
- 자세한 정책: [CLAUDE.md §1.2](CLAUDE.md#12-보안을-최우선으로).

---

## 문서

| 문서 | 용도 |
|------|------|
| [SIDABARI_SPEC.md](SIDABARI_SPEC.md) | 동작 사양서 (워크플로우 / UI / 설정 스키마) |
| [CLAUDE.md](CLAUDE.md) | 작업 규칙·보안 가이드·UI 스타일 가이드 (Claude Code 작업 시 1차 참조) |
| [docs/ec2-diag-setup/README.md](docs/ec2-diag-setup/README.md) | EC2 진단 키 + ForceCommand 셋업 상세 |

---

## 상태

- 1차 UI + 핵심 워크플로우 + Claude Code 훅 통합 + 진단 대시보드까지 구현 완료.
- 프로젝트는 활발히 변경 중 — 사양서가 1차 참조, 이 README는 요약.

---

## 라이선스

MIT License. [LICENSE](LICENSE) 파일 참조.

이 프로젝트가 유용하셨다면 그대로 쓰셔도, 포크해서 본인 환경에 맞게 손보셔도, 상업적으로 활용하셔도 자유롭습니다. 다만 위험 가능성이 있는 도구(SSH/SFTP/원격 명령 실행)이므로 무보증(AS IS) 조항을 충분히 인지하고 사용해 주세요.
