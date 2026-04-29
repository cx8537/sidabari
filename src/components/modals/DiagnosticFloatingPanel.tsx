import { useEffect, useState } from "react";
import { Rnd } from "react-rnd";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EC2Panel } from "@/components/panels/EC2Panel";
import { useAppStore } from "@/store/useAppStore";

// 사양서 §3.3 [D3] / §4.3 — EC2 진단 패널은 메인 layout 밖 floating frame.
// react-rnd로 자유 위치/크기, modal-less, 메인 윈도우 안 어디든 떠있음.
// 다른 패널 자유 사용 가능 (modal backdrop 없음).
// open=true → mount → SshTerminal mount → SSH connect.
// 닫기 버튼 또는 setDiagPanelOpen(false) → unmount → SshTerminal cleanup → SSH disconnect.
export function DiagnosticFloatingPanel() {
  const open = useAppStore((s) => s.diagPanelOpen);
  const setOpen = useAppStore((s) => s.setDiagPanelOpen);

  // 처음 위치는 화면 가운데 근처에서 시작 (resize 후 사용자 위치 기억은 미구현 — stage 8에서)
  const [initial] = useState(() => {
    const w = Math.min(900, Math.floor(window.innerWidth * 0.7));
    const h = Math.min(600, Math.floor(window.innerHeight * 0.7));
    return {
      x: Math.max(20, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(40, Math.floor((window.innerHeight - h) / 2)),
      w,
      h,
    };
  });

  // 닫혀있으면 mount 안 함 — child unmount → SshTerminal cleanup → SSH disconnect
  useEffect(() => {
    // open 상태 변경 시 react-rnd 위치 유지 (initial은 고정)
  }, [open]);

  if (!open) return null;

  return (
    <Rnd
      default={{ x: initial.x, y: initial.y, width: initial.w, height: initial.h }}
      minWidth={400}
      minHeight={250}
      bounds="window"
      dragHandleClassName="diag-drag-handle"
      className="z-50"
    >
      <div className="flex h-full w-full flex-col rounded-lg bg-background shadow-2xl ring-1 ring-foreground/15 overflow-hidden">
        {/* drag handle 헤더 */}
        <div className="diag-drag-handle flex cursor-move items-center justify-between gap-2 bg-card px-3 py-1.5 select-none">
          <span className="text-xs font-semibold text-card-foreground">
            EC2 진단 (플로팅)
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setOpen(false)}
            title="닫기 (SSH 세션 종료)"
            className="cursor-pointer"
          >
            <X />
          </Button>
        </div>
        {/* body — EC2Panel role=diagnostic */}
        <div className="min-h-0 flex-1">
          <EC2Panel role="diagnostic" />
        </div>
      </div>
    </Rnd>
  );
}
