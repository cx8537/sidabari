import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EC2Panel } from "@/components/panels/EC2Panel";
import { useAppStore } from "@/store/useAppStore";

// 사양서 §3.3 [D3] — EC2 진단 SSH 채널은 사용자가 필요할 때만 on-demand로 활성.
// modal=false → 다른 패널 사용 가능 (메인 monitor 등 동시 확인).
// open=true 시 EC2Panel(role="diagnostic") mount → SshTerminal mount → SSH connect.
// close 시 unmount → SshTerminal cleanup → SSH disconnect.
export function DiagnosticDialog() {
  const open = useAppStore((s) => s.diagPanelOpen);
  const setOpen = useAppStore((s) => s.setDiagPanelOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogContent className="h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] gap-0 bg-background p-0">
        <div className="flex h-full min-h-0 flex-col">
          <EC2Panel role="diagnostic" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
