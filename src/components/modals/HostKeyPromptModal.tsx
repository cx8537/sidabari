import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  listenSshHostKeyPrompt,
  sshAcceptHostKey,
  type HostKeyPromptPayload,
} from "@/lib/ssh";
import { useAppStore } from "@/store/useAppStore";

// 사양서 §1.2.3 — 첫 접속 시 호스트 키 fingerprint를 사용자에게 표시 + 명시적 승인 (TOFU).
// 자동 수락 모드 X. 사용자가 거부하면 SSH 연결 즉시 abort.
// 영구 known_hosts 저장은 다음 stage — 현재는 메모리 캐시 (백엔드).
export function HostKeyPromptModal() {
  const addEvent = useAppStore((s) => s.addEvent);
  const [pending, setPending] = useState<HostKeyPromptPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenSshHostKeyPrompt((payload) => {
      if (cancelled) return;
      // 동시에 여러 요청이 와도 마지막 것만 표시 (1인용 도구라 보통 한 번에 하나).
      setPending(payload);
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function respond(accepted: boolean) {
    if (!pending) return;
    const captured = pending;
    setPending(null);
    try {
      await sshAcceptHostKey(captured.request_id, accepted);
      addEvent(
        "SYSTEM",
        accepted
          ? `호스트 키 승인: ${captured.host}:${captured.port}`
          : `호스트 키 거부: ${captured.host}:${captured.port}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("SYSTEM", `호스트 키 응답 실패: ${msg}`);
    }
  }

  const open = pending !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 닫기(Esc/외부 클릭) = 거부
        if (!o) void respond(false);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-accent-gold">호스트 키 확인</DialogTitle>
          <DialogDescription>
            처음 접속하는 호스트입니다. fingerprint를 확인하고 승인해 주세요 (CLAUDE.md §1.2.3 TOFU).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2 text-sm">
          <div className="grid grid-cols-[5rem_1fr] gap-x-2">
            <span className="text-xs text-muted-foreground">호스트</span>
            <span className="font-mono text-card-foreground">
              {pending?.host}:{pending?.port}
            </span>
          </div>
          <div className="grid grid-cols-[5rem_1fr] gap-x-2 items-start">
            <span className="text-xs text-muted-foreground">Fingerprint</span>
            <span className="break-all font-mono text-xs text-accent-gold">
              {pending?.fingerprint}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            ※ 영구 저장은 다음 단계. 지금 승인은 앱 종료 시까지만 유효합니다.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => respond(false)}>
            거부
          </Button>
          <Button onClick={() => respond(true)}>승인</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
