export interface DriveInfo {
  path: string;
  label: string;
  fs: string;
  total: number;
  free: number;
  kind: string;
}

/** 백엔드가 보내는 가지치기된 트리 노드 */
export interface ViewNode {
  id: number;
  name: string;
  size: number;
  alloc: number;
  files: number;
  dirs: number;
  mtime: number;
  atime: number;
  isDir: boolean;
  flags: number;
  children?: ViewNode[];
  otherCount: number;
  otherSize: number;
  otherAlloc: number;
}

export interface Crumb {
  id: number;
  name: string;
}

export interface ViewSnapshot {
  root: ViewNode;
  path: string;
  crumbs: Crumb[];
  scanSize: number;
  scanAlloc: number;
}

export interface ScanProgress {
  scanId: number;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  elapsedMs: number;
  done: boolean;
  cancelled: boolean;
  current: string;
  view: ViewSnapshot;
}

export interface Hit {
  id: number;
  parent: number;
  name: string;
  path: string;
  size: number;
  alloc: number;
  files: number;
  dirs: number;
  mtime: number;
  atime: number;
  isDir: boolean;
}

/** UI 전역에서 "선택된 항목"으로 쓰는 공통 형태 */
export interface Selected {
  id: number;
  parent?: number;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  alloc: number;
  files: number;
  dirs: number;
  mtime: number;
  atime: number;
}

export interface ExtStat {
  ext: string;
  count: number;
  size: number;
}

export interface NodeDetails {
  id: number;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  alloc: number;
  files: number;
  dirs: number;
  mtime: number;
  atime: number;
  percentOfScan: number;
  extStats: ExtStat[];
  samples: { name: string; size: number; mtime: number }[];
  topChildren: { name: string; isDir: boolean; size: number; files: number }[];
  truncated: boolean;
}

export interface SumEntry {
  path: string;
  size: number;
  files: number;
  isDir: boolean;
  children: { name: string; isDir: boolean; size: number; files: number }[];
}

export interface ScanSummary {
  rootPath: string;
  totalSize: number;
  totalAlloc: number;
  files: number;
  dirs: number;
  errors: number;
  done: boolean;
  topDirs: SumEntry[];
  topFiles: SumEntry[];
  cacheCandidates: SumEntry[];
}

export interface CacheTarget {
  id: string;
  label: string;
  description: string;
  paths: string[];
  size: number;
  files: number;
  defaultChecked: boolean;
  needsAdmin: boolean;
}

export interface CleanResult {
  freed: number;
  deleted: number;
  failed: number;
}

export type Provider = "ollama" | "openai" | "anthropic";

export interface Settings {
  provider: Provider;
  ollamaUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiKey: string;
  openaiModel: string;
  anthropicKey: string;
  anthropicModel: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type Metric = "alloc" | "size";
export type ColorMode = "category" | "safety";
