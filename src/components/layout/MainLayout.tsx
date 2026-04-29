import { Group, Panel } from "react-resizable-panels";
import { MainToolbar } from "./MainToolbar";
import { ResizeHandle } from "./ResizeHandle";
import { MainClaudePanel } from "@/components/panels/MainClaudePanel";
import { ClaudeTabsPanel } from "@/components/panels/ClaudeTabsPanel";
import { EC2Panel } from "@/components/panels/EC2Panel";
import { ConsolePanel } from "@/components/panels/ConsolePanel";

export function MainLayout() {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <MainToolbar />
      <div className="min-h-0 flex-1 p-[3px]">
        <Group orientation="horizontal" style={{ height: "100%" }}>
          {/* 좌측 — 메인 Claude Code */}
          <Panel defaultSize="25%" minSize="15%">
            <MainClaudePanel />
          </Panel>

          <ResizeHandle />

          {/* 중앙 — 상단(Claude 탭) + 하단(EC2 메인 + 진단) */}
          <Panel defaultSize="50%" minSize="25%">
            <Group orientation="vertical" style={{ height: "100%" }}>
              <Panel defaultSize="50%" minSize="15%">
                <ClaudeTabsPanel />
              </Panel>

              <ResizeHandle />

              <Panel defaultSize="50%" minSize="15%">
                <Group orientation="horizontal" style={{ height: "100%" }}>
                  <Panel defaultSize="50%" minSize="15%">
                    <EC2Panel role="main" />
                  </Panel>

                  <ResizeHandle />

                  <Panel defaultSize="50%" minSize="15%">
                    <EC2Panel role="diagnostic" />
                  </Panel>
                </Group>
              </Panel>
            </Group>
          </Panel>

          <ResizeHandle />

          {/* 우측 — 도구 콘솔 */}
          <Panel defaultSize="25%" minSize="15%">
            <ConsolePanel />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
