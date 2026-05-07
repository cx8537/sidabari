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
  gateRespond,
  listenGateRequest,
  type GateRequestEmit,
} from "@/lib/hooks";
import { useAppStore } from "@/store/useAppStore";

// Phase 4 — PreToolUse(matcher="Bash") 게이트 모달.
//
// 사양서 §4.5 — 모달은 사람의 결정 게이트. 사용자가 명시적으로 [위험 도구 차단]을 활성화한 경우에만
// 발사된다. ESC/외부 클릭으로 닫으면 deny로 처리.
//
// 큐 정책: 새 요청이 도착하면 진행 중인 모달의 요청을 자동 deny 처리하고 새 요청만 표시.
// (다중 모달 큐는 복잡도 대비 가치 낮음 — Bash 동시 호출은 드문 케이스)

export function GateModal() {
  const [request, setRequest] = useState<GateRequestEmit | null>(null);
  const addEvent = useAppStore((s) => s.addEvent);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenGateRequest((req) => {
      if (cancelled) return;
      setRequest((prev) => {
        if (prev) {
          // 이전 요청은 자동 deny — gate.js timeout(30초)을 기다리는 대신 즉시 응답해 사용자 흐름 풀어줌.
          gateRespond(prev.request_id, "deny", "또돌이: 새 요청으로 자동 거부").catch(() => {});
          addEvent("HOOK", `gate: 이전 요청 자동 거부 (panel=${prev.panel_id ?? "?"})`);
        }
        return req;
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.warn("[GateModal] listen 실패:", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addEvent]);

  async function decide(decision: "allow" | "deny") {
    const cur = request;
    if (!cur) return;
    setRequest(null);
    try {
      await gateRespond(cur.request_id, decision);
      addEvent(
        "HOOK",
        `gate: ${decision} (panel=${cur.panel_id ?? "?"}, tool=${cur.payload.tool_name ?? "?"})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("HOOK", `gate: gateRespond 실패 — ${msg}`);
    }
  }

  if (!request) return null;

  const tool = request.payload.tool_name ?? "?";
  const input = request.payload.tool_input;
  const command =
    input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : null;
  const description =
    input && typeof input === "object" && typeof (input as { description?: unknown }).description === "string"
      ? (input as { description: string }).description
      : null;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) void decide("deny");
      }}
    >
      <DialogContent className="bg-card sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">위험 도구 호출 확인</DialogTitle>
          <DialogDescription>
            패널 <span className="font-mono">{request.panel_id ?? "?"}</span>의 Claude가 다음
            도구를 실행하려 합니다. 거부하면 Claude는 stderr 메시지를 받고 다른 방법을 시도합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-1 text-sm">
          <div>
            <span className="text-muted-foreground">도구: </span>
            <span className="font-mono text-card-foreground">{tool}</span>
          </div>
          {description && (
            <div>
              <span className="text-muted-foreground">설명: </span>
              <span className="text-card-foreground">{description}</span>
            </div>
          )}
          {command && (
            <div className="grid gap-1">
              <span className="text-muted-foreground">명령:</span>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-xs text-card-foreground">
                {command}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => void decide("deny")}>
            거부
          </Button>
          <Button onClick={() => void decide("allow")}>허용</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
