import { invoke } from "@tauri-apps/api/core";

// Phase 0 — Claude Code 훅 .claude/settings.local.json 설치 IPC (claudeSafety와 동형).

export type HookInstallReport = {
  installed_path: string;
  created: boolean;
  backed_up_path: string | null;
  events_added: string[];
};

export async function installClaudeHooks(
  directory: string,
  enableGate: boolean,
): Promise<HookInstallReport> {
  return await invoke<HookInstallReport>("install_claude_hooks", {
    directory,
    enableGate,
  });
}

export async function claudeHooksStatus(
  directory: string,
): Promise<HookInstallReport | null> {
  return await invoke<HookInstallReport | null>("claude_hooks_status", {
    directory,
  });
}
