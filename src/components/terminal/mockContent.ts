// 1단계 Mock 출력. 2단계에서 실제 pty/SSH 출력으로 대체.
// ANSI 색: \x1b[33m yellow, \x1b[32m green, \x1b[36m cyan, \x1b[31m red, \x1b[0m reset

export const MAIN_CLAUDE_LINES: string[] = [
  "\x1b[33mSidabari — 메인 Claude Code (Mock)\x1b[0m",
  "Claude Code 인스턴스가 실행되면 여기에 표시됩니다.",
  "EC2 패널의 \x1b[36m'분석 요청'\x1b[0m 클릭 시 컨텍스트 텍스트가 이 입력창에 주입됩니다.",
  "",
  "$ claude --version",
  "claude-code 1.0.0 (mock)",
  "$ ",
];

export const CLAUDE_TAB_LINES: Record<string, string[]> = {
  "1": [
    "\x1b[33mSidabari — 추가 Claude Code 탭 1 (Mock)\x1b[0m",
    "디렉토리: \x1b[36m/Users/me/projects/myapp-frontend\x1b[0m",
    "",
    "$ claude -c",
    "Claude Code: 무엇을 도와드릴까요?",
    "$ ",
  ],
  "2": [
    "\x1b[33mSidabari — 추가 Claude Code 탭 2 (Mock)\x1b[0m",
    "디렉토리: \x1b[36m/Users/me/projects/myapp-backend\x1b[0m",
    "",
    "$ claude -c",
    "Claude Code: 무엇을 도와드릴까요?",
    "$ ",
  ],
};

export const EC2_MAIN_LINES: string[] = [
  "\x1b[36mubuntu@ec2-xxx:~$\x1b[0m ./deploy.sh",
  "Stopping myapp service... \x1b[32m[OK]\x1b[0m",
  "Backing up current jar... \x1b[32m[OK]\x1b[0m",
  "Replacing jar... \x1b[32m[OK]\x1b[0m",
  "Starting myapp service... \x1b[32m[OK]\x1b[0m",
  "Service started, PID 12345",
  "",
  "\x1b[36mubuntu@ec2-xxx:~$\x1b[0m journalctl -u myapp -f",
  "[INFO] App starting...",
  "[INFO] DB connection established",
  "[INFO] HTTP server listening on :8080",
  "[INFO] Ready",
];

export const EC2_DIAGNOSTIC_LINES: string[] = [
  "\x1b[33m진단 SSH 세션 (Mock)\x1b[0m",
  "에러 발생 시 진단 명령을 여기서 실행합니다.",
  "",
  "\x1b[36mubuntu@ec2-xxx:~$\x1b[0m ps aux | grep myapp",
  "ubuntu   12345  2.1  4.5  ...  /opt/myapp/bin/myapp",
  "\x1b[36mubuntu@ec2-xxx:~$\x1b[0m df -h",
  "Filesystem      Size  Used Avail Use%",
  "/dev/xvda1      8.0G  6.5G  1.5G  82%",
  "\x1b[36mubuntu@ec2-xxx:~$\x1b[0m ",
];
