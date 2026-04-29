import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
  onAdd: (directory: string) => void;
};

const INPUT_CLASS =
  "h-8 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50";

// 사양서 §4.2 / §5.2 — 추가 Claude Code 탭 (`claude -c`로 실행).
// 사용자는 작업 디렉토리만 선택. label은 디렉토리 basename으로 자동 결정.
export function AddClaudeTabModal({ open, onOpenChange, onAdd }: Props) {
  const [dir, setDir] = useState<string>("");
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDir("");
      setPickError(null);
    }
  }, [open]);

  async function handlePick() {
    setPickError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: "Claude Code 작업 디렉토리 선택",
      });
      if (typeof selected === "string") setDir(selected);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleConfirm() {
    if (!dir.trim()) return;
    onAdd(dir);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">새 Claude Code 탭</DialogTitle>
          <DialogDescription>
            작업 디렉토리를 선택하면 그 폴더에서 <span className="font-mono">claude -c</span>가
            실행되어 새 탭으로 추가됩니다 (사양서 §4.2).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1 py-2">
          <label className="text-xs text-muted-foreground" htmlFor="claude-tab-dir">
            작업 디렉토리
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="claude-tab-dir"
              value={dir}
              readOnly
              placeholder="경로 버튼으로 폴더 선택"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            <Button type="button" variant="outline" size="default" onClick={handlePick} title="폴더 선택">
              <FolderOpen /> 경로
            </Button>
          </div>
          {pickError && (
            <p className="text-xs text-destructive">파일 선택 실패: {pickError}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            한 번 추가한 탭은 설정 파일에 저장되어 다음 실행 시 자동으로 살아납니다.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <Button onClick={handleConfirm} disabled={!dir.trim()}>
            확인
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
