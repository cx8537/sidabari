import { Group, Panel } from "react-resizable-panels";
import { MainToolbar } from "./MainToolbar";
import { ResizeHandle } from "./ResizeHandle";
import { MainClaudePanel } from "@/components/panels/MainClaudePanel";
import { ClaudeTabsPanel } from "@/components/panels/ClaudeTabsPanel";
import { EC2Panel } from "@/components/panels/EC2Panel";
import { ConsolePanel } from "@/components/panels/ConsolePanel";

// 2×2 grid 레이아웃 (사용자 요청 — 2026-04-29):
//   [0,0] 메인 Claude   |  [0,1] Claude Tabs
//   ─────────────────────┼─────────────────────
//   [1,0] 도구 콘솔     |  [1,1] EC2 메인
//
// EC2 진단 패널은 메인 layout에서 제거 — DiagnosticDialog로 on-demand 팝업.
export function MainLayout() {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <MainToolbar />
      <div className="min-h-0 flex-1 p-[3px]">
        <Group orientation="vertical" style={{ height: "100%" }}>
          {/* 0번 행 — Claude Code 화면들 */}
          <Panel defaultSize="50%" minSize="20%">
            <Group orientation="horizontal" style={{ height: "100%" }}>
              <Panel defaultSize="50%" minSize="20%">
                <MainClaudePanel />
              </Panel>
              <ResizeHandle />
              <Panel defaultSize="50%" minSize="20%">
                <ClaudeTabsPanel />
              </Panel>
            </Group>
          </Panel>

          <ResizeHandle />

          {/* 1번 행 — 도구 콘솔(1/5) + EC2 메인(4/5) */}
          <Panel defaultSize="50%" minSize="20%">
            <Group orientation="horizontal" style={{ height: "100%" }}>
              <Panel defaultSize="20%" minSize="12%">
                <ConsolePanel />
              </Panel>
              <ResizeHandle />
              <Panel defaultSize="80%" minSize="40%">
                <EC2Panel role="main" />
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </div>
  );
}
