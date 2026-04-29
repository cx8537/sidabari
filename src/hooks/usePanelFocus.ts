import { useAppStore, type PanelId } from "@/store/useAppStore";

export function usePanelFocus(panelId: PanelId) {
  const focusedId = useAppStore((s) => s.focusedPanelId);
  const setFocusedPanel = useAppStore((s) => s.setFocusedPanel);
  return {
    isFocused: focusedId === panelId,
    onMouseDown: () => setFocusedPanel(panelId),
  };
}
