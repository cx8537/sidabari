import { invoke } from "@tauri-apps/api/core";

// 사양서 §3.6 / CLAUDE.md §1.3 — Claude Code 권한 deny 규칙 설치 IPC.
// 메인 Claude 작업 디렉토리의 .claude/settings.local.json에 위험 명령 deny 규칙 추가.
// 핵심 방어선은 EC2 ForceCommand. 이 규칙은 보조선(scp/sftp/sudo systemctl 등 변형 시도 차단).

export type InstallReport = {
  installed_path: string;
  created: boolean;
  backed_up_path: string | null;
  deny_count: number;
};

export async function installClaudeSafetyRules(
  directory: string,
): Promise<InstallReport> {
  return await invoke<InstallReport>("install_claude_safety_rules", {
    directory,
  });
}

export async function claudeSafetyRulesStatus(
  directory: string,
): Promise<InstallReport | null> {
  return await invoke<InstallReport | null>("claude_safety_rules_status", {
    directory,
  });
}
