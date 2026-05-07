import { invoke } from "@tauri-apps/api/core";

// 진단 SSH 자동 허용 IPC — claude_safety / claudeHooks와 동형 패턴.
// 메인 Claude 패널의 [시스템 데이터 수집]이 매번 사용자 승인 없이 실행되도록
// .claude/settings.local.json `permissions.allow`에 호스트 바운드 ssh 패턴 등록.

export type DiagAllowReport = {
  installed_path: string;
  created: boolean;
  backed_up_path: string | null;
  /** 등록된 모든 ssh 패턴 (인자 없는 끝 + 인자 있는 끝 두 형태). */
  patterns: string[];
  /** auto mode classifier에게 보여줄 자연어 자기 설명 entry. */
  automode_entry: string;
  removed_count: number;
};

export async function installDiagSshAllow(
  directory: string,
  host: string,
  user: string,
): Promise<DiagAllowReport> {
  return await invoke<DiagAllowReport>("install_diag_ssh_allow", {
    directory,
    host,
    user,
  });
}

export async function removeDiagSshAllow(
  directory: string,
): Promise<DiagAllowReport> {
  return await invoke<DiagAllowReport>("remove_diag_ssh_allow", { directory });
}

export async function diagSshAllowStatus(
  directory: string,
): Promise<DiagAllowReport | null> {
  return await invoke<DiagAllowReport | null>("diag_ssh_allow_status", {
    directory,
  });
}
