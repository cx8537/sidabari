import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 1단계 Mock — 실제 설정 IPC는 task #3에서 연결.
export function SettingsModal({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">설정</DialogTitle>
          <DialogDescription>
            Sidabari 설정 — 사양서 §5.2 스키마 기반 (현재 Mock, 저장은 task #3 IPC 연동 시 활성화)
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="display-name">
              표시 이름
            </label>
            <input
              id="display-name"
              defaultValue="또돌이"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="ec2-host">
              EC2 호스트
            </label>
            <input
              id="ec2-host"
              placeholder="ec2-xxx.compute.amazonaws.com"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="pem-path">
              개인키 경로 (.pem)
            </label>
            <input
              id="pem-path"
              placeholder="C:\Users\me\.ssh\myapp-key.pem"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              파일 내용이 아닌 경로만 저장 (CLAUDE.md §1.2.1)
            </p>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button>확인</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
