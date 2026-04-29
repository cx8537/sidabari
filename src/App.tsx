import "./App.css";
import { MainLayout } from "@/components/layout/MainLayout";
import { HostKeyPromptModal } from "@/components/modals/HostKeyPromptModal";
import { DiagnosticFloatingPanel } from "@/components/modals/DiagnosticFloatingPanel";
import { MonitorMatcher } from "@/components/monitor/MonitorMatcher";
import { SshGraceWatcher } from "@/components/monitor/SshGraceWatcher";

function App() {
  return (
    <>
      <MainLayout />
      <HostKeyPromptModal />
      <DiagnosticFloatingPanel />
      <MonitorMatcher />
      <SshGraceWatcher />
    </>
  );
}

export default App;
