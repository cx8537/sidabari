import "./App.css";
import { MainLayout } from "@/components/layout/MainLayout";
import { HostKeyPromptModal } from "@/components/modals/HostKeyPromptModal";
import { DiagnosticFloatingPanel } from "@/components/modals/DiagnosticFloatingPanel";
import { GateModal } from "@/components/modals/GateModal";
import { MonitorMatcher } from "@/components/monitor/MonitorMatcher";
import { SshGraceWatcher } from "@/components/monitor/SshGraceWatcher";
import { HookBridge } from "@/components/monitor/HookBridge";

function App() {
  return (
    <>
      <MainLayout />
      <HostKeyPromptModal />
      <DiagnosticFloatingPanel />
      <GateModal />
      <MonitorMatcher />
      <SshGraceWatcher />
      <HookBridge />
    </>
  );
}

export default App;
