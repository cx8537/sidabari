import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

// 사양서 §5.2 스키마. Rust 측 src-tauri/src/config.rs 와 1:1 대응.
// IPC 응답 검증 (CLAUDE.md §3.2): zod로 런타임 파싱.

export const ProjectSchema = z.object({
  name: z.string(),
});

export const ClaudeCodeSessionSchema = z.object({
  label: z.string(),
  directory: z.string(),
  auto_start: z.boolean(),
});

export const ClaudeCodeSessionsSchema = z.object({
  main: ClaudeCodeSessionSchema,
  additional: z.array(ClaudeCodeSessionSchema),
});

export const Ec2ConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  user: z.string(),
  private_key_path: z.string(),
  // 진단 전용 키 — 서버 측 ForceCommand로 잠긴 키 (docs/ec2-diag-setup 참조).
  // Claude의 [시스템 데이터 수집]이 이 키만 사용하도록 분리.
  diag_private_key_path: z.string().default(""),
});

export const SftpConfigSchema = z.object({
  use_same_as_ssh: z.boolean(),
  remote_upload_path: z.string(),
});

export const DeployConfigSchema = z.object({
  build_command: z.string(),
  build_working_directory: z.string(),
  jar_output_path: z.string(),
  build_timeout_seconds: z.number().int().nonnegative(),
  deploy_script: z.string(),
  restart_script: z.string(),
  stop_script: z.string(),
});

export const MonitoringConfigSchema = z.object({
  log_command: z.string(),
  error_pattern: z.string(),
  context_lines_before: z.number().int().nonnegative(),
  context_lines_after: z.number().int().nonnegative(),
  context_capture_delay_seconds: z.number().int().nonnegative(),
});

export const SafetyConfigSchema = z.object({
  ssh_disconnect_grace_seconds: z.number().int().nonnegative(),
});

export const ConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  display_name: z.string(),
  project: ProjectSchema,
  claude_code_sessions: ClaudeCodeSessionsSchema,
  ec2: Ec2ConfigSchema,
  sftp: SftpConfigSchema,
  deploy: DeployConfigSchema,
  monitoring: MonitoringConfigSchema,
  safety: SafetyConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const raw = await invoke("load_config");
  return ConfigSchema.parse(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  await invoke("save_config", { config });
}

export async function getConfigPath(): Promise<string> {
  return await invoke<string>("config_path");
}
