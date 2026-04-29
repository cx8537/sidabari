import "./App.css";
import { MainLayout } from "@/components/layout/MainLayout";
import { HostKeyPromptModal } from "@/components/modals/HostKeyPromptModal";
import { DiagnosticFloatingPanel } from "@/components/modals/DiagnosticFloatingPanel";
import { MonitorMatcher } from "@/components/monitor/MonitorMatcher";

function App() {
  return (
    <>
      <MainLayout />
      <HostKeyPromptModal />
      <DiagnosticFloatingPanel />
      <MonitorMatcher />
    </>
  );
}

export default App;
