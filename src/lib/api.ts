import { invoke } from "@tauri-apps/api/core";
import type {
  CacheTarget,
  ChatMessage,
  CleanResult,
  DriveInfo,
  Hit,
  NodeDetails,
  ScanSummary,
  Settings,
  ViewSnapshot,
} from "../types";

export const api = {
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  startScan: (path: string) => invoke<number>("start_scan", { path }),
  cancelScan: () => invoke<void>("cancel_scan"),
  setView: (node: number, depth: number, byAlloc: boolean) =>
    invoke<ViewSnapshot>("set_view", { node, depth, byAlloc }),
  getTopFiles: (limit = 100) => invoke<Hit[]>("get_top_files", { limit }),
  search: (query: string, limit = 300) =>
    invoke<{ total: number; hits: Hit[] }>("search_nodes", { query, limit }),
  getNodeDetails: (id: number) => invoke<NodeDetails>("get_node_details", { id }),
  getScanSummary: () => invoke<ScanSummary>("get_scan_summary"),
  openInExplorer: (path: string) => invoke<void>("open_in_explorer", { path }),
  moveToTrash: (path: string, nodeId: number | null) =>
    invoke<void>("move_to_trash", { path, nodeId }),
  runCleanupCmd: (id: string) => invoke<string>("run_system_cleanup_cmd", { id }),
  scanSafeCaches: () => invoke<CacheTarget[]>("scan_safe_caches"),
  cleanSafeCaches: (ids: string[]) => invoke<CleanResult>("clean_safe_caches", { ids }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  initialScanPath: () => invoke<string | null>("initial_scan_path"),
  isElevated: () => invoke<boolean>("is_elevated"),
  restartAsAdmin: () => invoke<void>("restart_as_admin"),
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  llmChat: (system: string, messages: ChatMessage[], wantJson: boolean) =>
    invoke<string>("llm_chat", { system, messages, wantJson }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
