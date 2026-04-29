import { Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

const baseClasses = [
  "relative bg-transparent outline-none focus:outline-none focus-visible:outline-none",
  "aria-[orientation=vertical]:w-1.5 aria-[orientation=horizontal]:h-1.5",
  "after:absolute after:bg-border after:transition-colors",
  "aria-[orientation=vertical]:after:left-1/2 aria-[orientation=vertical]:after:top-0 aria-[orientation=vertical]:after:h-full aria-[orientation=vertical]:after:w-px aria-[orientation=vertical]:after:-translate-x-1/2",
  "aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:-translate-y-1/2",
  "hover:after:bg-foreground/15",
  "focus-visible:after:bg-foreground/15",
  "data-[separator=active]:after:bg-foreground/60",
].join(" ");

export function ResizeHandle() {
  return <Separator className={cn(baseClasses)} />;
}
