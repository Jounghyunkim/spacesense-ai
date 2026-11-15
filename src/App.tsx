import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import AiAdvisorPanel from "./components/AiAdvisorPanel";
import FileTable from "./components/FileTable";
import { HeaderBar, NavBar, StatusBar } from "./components/HeaderBar";
import { ConfirmDialog, ContextMenu, QuickCleanModal, SettingsModal, Toasts } from "./components/Overlays";
import TreemapCanvas from "./components/TreemapCanvas";
import { CATEGORY_META, LEVEL_META, type Category } from "./services/storageAdvisor";
import { useStore } from "./store";
import type { ScanProgress } from "./types";

function Legend() {
  const colorMode = useStore((s) => s.colorMode);
  const items =
    colorMode === "category"
      ? (Object.keys(CATEGORY_META) as Category[]).map((k) => CATEGORY_META[k])
      : [
          { label: "삭제 안전", color: LEVEL_META.safe.color },
          { label: "확인 필요 · 전용 도구", color: LEVEL_META.caution.color },
          { label: "삭제 절대 금지 · OS 코어", color: LEVEL_META.critical.color },
          { label: "분류되지 않음", color: LEVEL_META.unknown.color },
        ];
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden px-2.5 text-[11px] text-slate-400">
      {items.map((i) => (
        <span key={i.label} className="flex shrink-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export default function App() {
  const panelOpen = useStore((s) => s.panelOpen);

  useEffect(() => {
    void useStore.getState().init();
    const un = listen<ScanProgress>("scan-progress", (e) => useStore.getState().onProgress(e.payload));
    // 웹뷰 기본 우클릭 메뉴는 입력창에서만 허용
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) e.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) useStore.getState().navigateUp();
      if (e.key === "F5") {
        e.preventDefault();
        void useStore.getState().startScan();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      void un.then((f) => f());
      window.removeEventListener("contextmenu", block);
      window.removeEventListener("keydown", key);
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <HeaderBar />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <NavBar />
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-slate-900/60">
              <div className="min-h-0 flex-1 p-1.5 pb-0">
                <TreemapCanvas />
              </div>
              <Legend />
            </section>
            <FileTable />
          </div>
        </main>
        {panelOpen && <AiAdvisorPanel />}
      </div>
      <StatusBar />
      <ContextMenu />
      <SettingsModal />
      <QuickCleanModal />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
