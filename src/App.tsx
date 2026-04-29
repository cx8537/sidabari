import "./App.css";
import { MainLayout } from "@/components/layout/MainLayout";
import { HostKeyPromptModal } from "@/components/modals/HostKeyPromptModal";

function App() {
  return (
    <>
      <MainLayout />
      <HostKeyPromptModal />
    </>
  );
}

export default App;
