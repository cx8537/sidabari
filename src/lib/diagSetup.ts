import { invoke } from "@tauri-apps/api/core";

// 원클릭 진단 셋업 — 키페어 ensure + staging IPC.
// install.sh 실행과 SFTP 업로드는 frontend가 기존 ssh_exec/sftp_upload를 invoke해 처리한다.

export type DiagSetupPrepareReport = {
  diag_private_key_path: string;
  diag_public_key_path: string;
  created_new_keypair: boolean;
  setup_id: string;
  remote_setup_dir: string;
  staging_install_path: string;
  staging_collect_path: string;
  staging_pub_path: string;
};

export async function diagSetupPrepare(
  diagKeyPath?: string,
): Promise<DiagSetupPrepareReport> {
  return await invoke<DiagSetupPrepareReport>("diag_setup_prepare", {
    opts: { diag_key_path: diagKeyPath ?? null },
  });
}

export async function diagSetupCleanup(setupId: string): Promise<void> {
  await invoke("diag_setup_cleanup", { setupId });
}
