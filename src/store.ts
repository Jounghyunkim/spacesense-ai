import { create } from "zustand";
import { api, errorText } from "./lib/api";
import type { Rect } from "./lib/treemap";
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildChatSystemPrompt,
  classifyPath,
  isTrashBlocked,
  parseAnalysis,
  type AiAnalysis,
} from "./services/storageAdvisor";
import type {
  ChatMessage,
  ColorMode,
  DriveInfo,
  Hit,
  Metric,
  ScanProgress,
  ScanSummary,
  Selected,
  Settings,
  ViewSnapshot,
} from "./types";

export interface Stats {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  elapsedMs: number;
  current: string;
  cancelled: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export interface AiState {
  /** 분석 대상 경로 */
  path: string | null;
  loading: boolean;
  analysis: AiAnalysis | null;
  /** JSON 파싱에 실패했을 때의 원문 */
  raw: string | null;
  error: string | null;
}

export type TableTab = "current" | "top" | "search";

const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiKey: "",
  openaiModel: "gpt-4o-mini",
  anthropicKey: "",
  anthropicModel: "claude-opus-5-5",
};

interface State {
  drives: DriveInfo[];
  rootPath: string;
  scanId: number;
  scanning: boolean;
  hasScan: boolean;
  stats: Stats | null;

  view: ViewSnapshot | null;
  viewRootId: number;
  depth: number;
  metric: Metric;
  colorMode: ColorMode;
  zoomFrom: Rect | null;

  selected: Selected | null;
  search: string;
  searchHits: Hit[];
  searchTotal: number;
  topFiles: Hit[];
  tableTab: TableTab;
  tableOpen: boolean;
  panelOpen: boolean;

  settings: Settings;
  elevated: boolean;
  showSettings: boolean;
  showQuickClean: boolean;
  ctxMenu: { x: number; y: number; item: Selected } | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];

  ai: AiState;
  chat: ChatMessage[];
  chatLoading: boolean;

  init: () => Promise<void>;
  refreshDrives: () => Promise<void>;
  setRootPath: (p: string) => void;
  pickFolder: () => Promise<void>;
  startScan: () => Promise<void>;
  cancelScan: () => Promise<void>;
  onProgress: (p: ScanProgress) => void;
  navigate: (id: number, zoomFrom?: Rect | null) => Promise<void>;
  navigateUp: () => void;
  setDepth: (d: number) => void;
  setMetric: (m: Metric) => void;
  setColorMode: (m: ColorMode) => void;
  consumeZoom: () => void;
  select: (s: Selected | null) => void;
  setSearch: (q: string) => Promise<void>;
  refreshTop: () => Promise<void>;
  refreshView: () => Promise<void>;
  set: (patch: Partial<State>) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;

  openInExplorer: (path: string) => Promise<void>;
  copyText: (text: string, what?: string) => Promise<void>;
  requestTrash: (item: Selected) => void;
  runCommand: (id: string, label: string) => void;
  saveSettings: (s: Settings) => Promise<void>;

  analyze: (item: Selected) => Promise<void>;
  sendChat: (text: string) => Promise<void>;
  clearChat: () => void;
}

let toastSeq = 0;
let progressTick = 0;

const EMPTY_AI: AiState = { path: null, loading: false, analysis: null, raw: null, error: null };

export const useStore = create<State>()((set, get) => ({
  drives: [],
  rootPath: "",
  scanId: 0,
  scanning: false,
  hasScan: false,
  stats: null,

  view: null,
  viewRootId: 0,
  depth: 3,
  metric: "alloc",
  colorMode: "category",
  zoomFrom: null,

  selected: null,
  search: "",
  searchHits: [],
  searchTotal: 0,
  topFiles: [],
  tableTab: "current",
  tableOpen: true,
  panelOpen: true,

  settings: DEFAULT_SETTINGS,
  elevated: false,
  showSettings: false,
  showQuickClean: false,
  ctxMenu: null,
  confirm: null,
  toasts: [],

  ai: EMPTY_AI,
  chat: [],
  chatLoading: false,

  set: (patch) => set(patch),

  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  init: async () => {
    try {
      const [drives, settings, elevated, initial] = await Promise.all([
        api.listDrives(),
        api.loadSettings(),
        api.isElevated(),
        api.initialScanPath(),
      ]);
      const sys = drives.find((d) => d.path.toUpperCase().startsWith("C")) ?? drives[0];
      set({
        drives,
        settings: { ...DEFAULT_SETTINGS, ...settings },
        elevated,
        rootPath: initial || get().rootPath || sys?.path || "",
      });
      // `--scan <경로>` 로 실행되었으면 바로 스캔 (StrictMode 이중 호출 방지)
      if (initial && !get().hasScan) await get().startScan();
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  refreshDrives: async () => {
    try {
      set({ drives: await api.listDrives() });
    } catch {
      /* 드라이브 갱신 실패는 무시 */
    }
  },

  setRootPath: (p) => set({ rootPath: p }),

  pickFolder: async () => {
    const p = await api.pickFolder();
    if (p) {
      set({ rootPath: p });
      await get().startScan();
    }
  },

  startScan: async () => {
    const { rootPath, toast } = get();
    if (!rootPath) {
      toast("error", "스캔할 드라이브 또는 폴더를 선택하세요.");
      return;
    }
    try {
      const scanId = await api.startScan(rootPath);
      progressTick = 0;
      set({
        scanId,
        scanning: true,
        hasScan: true,
        stats: null,
        view: null,
        viewRootId: 0,
        selected: null,
        topFiles: [],
        searchHits: [],
        searchTotal: 0,
        zoomFrom: null,
        ai: EMPTY_AI,
        tableTab: get().tableTab === "search" && !get().search ? "current" : get().tableTab,
      });
      // 백엔드 뷰 요청을 현재 UI 설정과 동기화
      void api.setView(0, get().depth, get().metric === "alloc").catch(() => {});
    } catch (e) {
      toast("error", errorText(e));
    }
  },

  cancelScan: async () => {
    await api.cancelScan();
  },

  onProgress: (p) => {
    const s = get();
    if (p.scanId !== s.scanId) return;
    const patch: Partial<State> = {
      stats: {
        files: p.files,
        dirs: p.dirs,
        bytes: p.bytes,
        errors: p.errors,
        elapsedMs: p.elapsedMs,
        current: p.current,
        cancelled: p.cancelled,
      },
    };
    if (p.view.root.id === s.viewRootId) patch.view = p.view;
    if (p.done) patch.scanning = false;
    set(patch);
    progressTick++;
    if (p.done || progressTick % 5 === 0) void get().refreshTop();
    if (p.done) {
      void get().refreshDrives();
      if (get().search) void get().setSearch(get().search);
      if (!p.cancelled) {
        get().toast(
          "success",
          `스캔 완료: 파일 ${p.files.toLocaleString()}개 · ${(p.elapsedMs / 1000).toFixed(1)}초`,
        );
      }
    }
  },

  navigate: async (id, zoomFrom = null) => {
    const s = get();
    if (!s.hasScan) return;
    set({ viewRootId: id, zoomFrom });
    try {
      const view = await api.setView(id, s.depth, s.metric === "alloc");
      if (get().viewRootId === id) set({ view, viewRootId: view.root.id });
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  navigateUp: () => {
    const v = get().view;
    if (v && v.crumbs.length >= 2) void get().navigate(v.crumbs[v.crumbs.length - 2].id);
  },

  refreshView: async () => {
    const s = get();
    if (!s.hasScan) return;
    try {
      const view = await api.setView(s.viewRootId, s.depth, s.metric === "alloc");
      if (get().viewRootId === s.viewRootId) set({ view, viewRootId: view.root.id });
    } catch {
      /* 스캔 교체 중일 수 있음 */
    }
  },

  setDepth: (d) => {
    set({ depth: d });
    void get().refreshView();
  },
  setMetric: (m) => {
    set({ metric: m });
    void get().refreshView();
  },
  setColorMode: (m) => set({ colorMode: m }),
  consumeZoom: () => set({ zoomFrom: null }),

  select: (item) => {
    const prev = get().ai;
    set({
      selected: item,
      ai: item && prev.path === item.path ? prev : EMPTY_AI,
    });
  },

  setSearch: async (q) => {
    set({ search: q });
    if (!q.trim()) {
      set((s) => ({
        searchHits: [],
        searchTotal: 0,
        tableTab: s.tableTab === "search" ? "current" : s.tableTab,
      }));
      return;
    }
    if (!get().hasScan) return;
    try {
      const r = await api.search(q);
      if (get().search === q) {
        set({ searchHits: r.hits, searchTotal: r.total, tableTab: "search", tableOpen: true });
      }
    } catch {
      /* 무시 */
    }
  },

  refreshTop: async () => {
    if (!get().hasScan) return;
    try {
      set({ topFiles: await api.getTopFiles(100) });
    } catch {
      /* 무시 */
    }
  },

  openInExplorer: async (path) => {
    try {
      await api.openInExplorer(path);
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  copyText: async (text, what = "경로") => {
    try {
      await api.copyText(text);
      get().toast("info", `${what}를 클립보드에 복사했습니다.`);
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  requestTrash: (item) => {
    const verdict = classifyPath(item.path);
    if (isTrashBlocked(verdict)) {
      get().toast("error", `${verdict.title}: 직접 삭제할 수 없습니다. ${verdict.message}`);
      return;
    }
    set({
      confirm: {
        title: "휴지통으로 이동",
        message: `${item.isDir ? "폴더" : "파일"} "${item.name}" 을(를) 휴지통으로 이동할까요?`,
        detail:
          `${item.path}\n\n` +
          (verdict.level === "safe"
            ? "안전한 캐시/임시 항목으로 분류되었습니다."
            : verdict.level === "unknown"
              ? "분류되지 않은 항목입니다. 무엇인지 확실할 때만 삭제하세요."
              : `주의: ${verdict.message}`) +
          "\n휴지통에서 복원할 수 있으며, 휴지통을 비워야 실제 공간이 확보됩니다.",
        confirmLabel: "휴지통으로 이동",
        danger: verdict.level !== "safe",
        onConfirm: async () => {
          const s = get();
          try {
            // 현재 보고 있는 폴더 자체를 지우는 경우 먼저 상위로 이동
            const wasViewRoot = item.id === s.viewRootId;
            await api.moveToTrash(item.path, item.id >= 0 ? item.id : null);
            get().toast("success", `휴지통으로 이동했습니다: ${item.name}`);
            if (get().selected?.path === item.path) get().select(null);
            if (wasViewRoot && s.view && s.view.crumbs.length >= 2) {
              await get().navigate(s.view.crumbs[s.view.crumbs.length - 2].id);
            } else {
              await get().refreshView();
            }
            void get().refreshTop();
            if (get().search) void get().setSearch(get().search);
          } catch (e) {
            get().toast("error", errorText(e));
          }
        },
      },
    });
  },

  runCommand: (id, label) => {
    set({
      confirm: {
        title: "정리 명령 실행",
        message: `"${label}" 을(를) 실행할까요?`,
        detail: "관리자 권한이 필요한 명령은 UAC 확인 창이 표시되며, 새 콘솔 창에서 진행 상황을 볼 수 있습니다.",
        confirmLabel: "실행",
        onConfirm: async () => {
          try {
            get().toast("success", await api.runCleanupCmd(id));
            setTimeout(() => void get().refreshDrives(), 3000);
          } catch (e) {
            get().toast("error", errorText(e));
          }
        },
      },
    });
  },

  saveSettings: async (s) => {
    try {
      await api.saveSettings(s);
      set({ settings: s, showSettings: false });
      get().toast("success", "설정을 저장했습니다.");
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  analyze: async (item) => {
    if (item.id < 0) return;
    set({ panelOpen: true, ai: { ...EMPTY_AI, path: item.path, loading: true } });
    const still = () => get().ai.path === item.path;
    try {
      const details = await api.getNodeDetails(item.id);
      const prompt = buildAnalysisPrompt(details, classifyPath(details.path));
      const text = await api.llmChat(ANALYSIS_SYSTEM_PROMPT, [{ role: "user", content: prompt }], true);
      if (!still()) return;
      const analysis = parseAnalysis(text);
      set({
        ai: { path: item.path, loading: false, analysis, raw: analysis ? null : text, error: null },
      });
    } catch (e) {
      if (still()) set({ ai: { ...EMPTY_AI, path: item.path, error: errorText(e) } });
    }
  },

  sendChat: async (text) => {
    const q = text.trim();
    if (!q || get().chatLoading) return;
    const history: ChatMessage[] = [...get().chat, { role: "user", content: q }];
    set({ chat: history, chatLoading: true, panelOpen: true });
    try {
      let summary: ScanSummary | null = null;
      if (get().hasScan) summary = await api.getScanSummary().catch(() => null);
      const system = buildChatSystemPrompt(summary, get().selected);
      // 최근 대화만 보내되, 첫 메시지는 반드시 user 여야 한다.
      let recent = history.slice(-12);
      while (recent[0]?.role === "assistant") recent = recent.slice(1);
      const answer = await api.llmChat(system, recent, false);
      set({ chat: [...history, { role: "assistant", content: answer }], chatLoading: false });
    } catch (e) {
      set({
        chat: [...history, { role: "assistant", content: `⚠️ ${errorText(e)}` }],
        chatLoading: false,
      });
    }
  },

  clearChat: () => set({ chat: [] }),
}));

/** 표/트리맵 등에서 Hit 을 선택 항목으로 변환 */
export function hitToSelected(h: Hit): Selected {
  return { ...h };
}
