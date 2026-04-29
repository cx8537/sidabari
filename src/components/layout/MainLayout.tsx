import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { MainToolbar } from "./MainToolbar";
import { ResizeHandle } from "./ResizeHandle";
import { MainClaudePanel } from "@/components/panels/MainClaudePanel";
import { ClaudeTabsPanel } from "@/components/panels/ClaudeTabsPanel";
import { EC2Panel } from "@/components/panels/EC2Panel";
import { ConsolePanel } from "@/components/panels/ConsolePanel";

// 2×2 grid 레이아웃:
//   [0,0] 메인 Claude   |  [0,1] Claude Tabs
//   [1,0] 도구 콘솔     |  [1,1] EC2 메인
//
// useDefaultLayout: localStorage에 group 비율 저장/복원 — 재시작 시 사용자 분할 유지.
// EC2 진단 패널은 메인 layout에서 제거 — DiagnosticFloatingPanel(react-rnd)로 on-demand 팝업.
const STORAGE: Storage | undefined =
  typeof window !== "undefined" ? window.localStorage : undefined;

export function MainLayout() {
  const rows = useDefaultLayout({ id: "sidabari-rows", storage: STORAGE });
  const row0 = useDefaultLayout({ id: "sidabari-row0", storage: STORAGE });
  const row1 = useDefaultLayout({ id: "sidabari-row1", storage: STORAGE });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <MainToolbar />
      <div className="min-h-0 flex-1 p-[3px]">
        <Group
          orientation="vertical"
          defaultLayout={rows.defaultLayout}
          onLayoutChanged={rows.onLayoutChanged}
          style={{ height: "100%" }}
        >
          {/* 0번 행 — Claude Code 화면들 */}
          <Panel id="row-0" defaultSize="50%" minSize="20%">
            <Group
              orientation="horizontal"
              defaultLayout={row0.defaultLayout}
              onLayoutChanged={row0.onLayoutChanged}
              style={{ height: "100%" }}
            >
              <Panel id="main-claude" defaultSize="50%" minSize="20%">
                <MainClaudePanel />
              </Panel>
              <ResizeHandle />
              <Panel id="claude-tabs" defaultSize="50%" minSize="20%">
                <ClaudeTabsPanel />
              </Panel>
            </Group>
          </Panel>

          <ResizeHandle />

          {/* 1번 행 — 도구 콘솔(1/5) + EC2 메인(4/5) */}
          <Panel id="row-1" defaultSize="50%" minSize="20%">
            <Group
              orientation="horizontal"
              defaultLayout={row1.defaultLayout}
              onLayoutChanged={row1.onLayoutChanged}
              style={{ height: "100%" }}
            >
              <Panel id="console" defaultSize="20%" minSize="12%">
                <ConsolePanel />
              </Panel>
              <ResizeHandle />
              <Panel id="ec2-main" defaultSize="80%" minSize="40%">
                <EC2Panel role="main" />
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </div>
  );
}
