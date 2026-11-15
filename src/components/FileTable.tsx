import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, File, Folder } from "lucide-react";
import { formatBytes, formatDate, joinPath, percent } from "../lib/format";
import { LEVEL_META, classifyPath } from "../services/storageAdvisor";
import { useStore, type TableTab } from "../store";
import type { Selected } from "../types";

type SortKey = "name" | "path" | "size" | "atime" | "safety";

const SAFETY_ORDER = { safe: 0, unknown: 1, caution: 2, action: 3, critical: 4 } as const;

export default function FileTable() {
  const view = useStore((s) => s.view);
  const topFiles = useStore((s) => s.topFiles);
  const searchHits = useStore((s) => s.searchHits);
  const searchTotal = useStore((s) => s.searchTotal);
  const search = useStore((s) => s.search);
  const tab = useStore((s) => s.tableTab);
  const open = useStore((s) => s.tableOpen);
  const metric = useStore((s) => s.metric);
  const selected = useStore((s) => s.selected);
  const set = useStore((s) => s.set);
  const select = useStore((s) => s.select);
  const navigate = useStore((s) => s.navigate);

  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [asc, setAsc] = useState(false);

  const rows: Selected[] = useMemo(() => {
    if (tab === "top") return topFiles;
    if (tab === "search") return searchHits;
    if (!view) return [];
    return (view.root.children ?? []).map((c) => ({
      id: c.id,
      parent: view.root.id,
      name: c.name,
      path: joinPath(view.path, c.name),
      isDir: c.isDir,
      size: c.size,
      alloc: c.alloc,
      files: c.files,
      dirs: c.dirs,
      mtime: c.mtime,
      atime: c.atime,
    }));
  }, [tab, topFiles, searchHits, view]);

  const val = (r: Selected) => (metric === "alloc" ? r.alloc : r.size);
  // 비율 기준: 현재 폴더 탭은 현재 보기, 그 외는 스캔 전체
  const total = !view
    ? 0
    : tab === "current"
      ? metric === "alloc"
        ? view.root.alloc
        : view.root.size
      : metric === "alloc"
        ? view.scanAlloc
        : view.scanSize;

  const sorted = useMemo(() => {
    const dir = asc ? 1 : -1;
    const arr = [...rows];
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * a.name.localeCompare(b.name);
        case "path":
          return dir * a.path.localeCompare(b.path);
        case "atime":
          return dir * (a.atime - b.atime);
        case "safety":
          return (
            dir *
            (SAFETY_ORDER[classifyPath(a.path).level] - SAFETY_ORDER[classifyPath(b.path).level])
          );
        default:
          return dir * (val(a) - val(b));
      }
    });
    return arr.slice(0, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, asc, metric]);

  const header = (key: SortKey, label: string, cls: string, indicator = true) => (
    <th
      className={`sticky top-0 z-[1] cursor-pointer select-none bg-slate-900 px-3 py-1.5 text-left font-medium text-slate-400 hover:text-slate-100 ${cls}`}
      onClick={() => {
        if (sortKey === key) setAsc(!asc);
        else {
          setSortKey(key);
          setAsc(key === "name" || key === "path");
        }
      }}
    >
      {label}
      {indicator && sortKey === key && (
        <span className="ml-1 text-sky-400">{asc ? "▲" : "▼"}</span>
      )}
    </th>
  );

  const tabBtn = (t: TableTab, label: string, count?: number) => (
    <button
      onClick={() => set({ tableTab: t, tableOpen: true })}
      className={`rounded-md px-2.5 py-1 text-[12px] ${
        tab === t && open ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 text-[11px] text-slate-500">{count.toLocaleString()}</span>}
    </button>
  );

  return (
    <section
      className={`flex shrink-0 flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-slate-900/60 ${
        open ? "h-[270px]" : "h-10"
      }`}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-800/80 px-2">
        {tabBtn("current", "현재 폴더 항목", view?.root.children?.length)}
        {tabBtn("top", "대용량 파일 Top 100", topFiles.length)}
        {search && tabBtn("search", `검색: ${search}`, searchTotal)}
        <div className="flex-1" />
        <button
          onClick={() => set({ tableOpen: !open })}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          title={open ? "목록 접기" : "목록 펼치기"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
      </div>

      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-[12px]">
            <thead>
              <tr>
                {header("name", "이름", "w-[24%]")}
                {header("path", "경로", "w-[30%]")}
                {header("size", "용량", "w-[9%] text-right")}
                {header("size", "비율", "w-[15%]", false)}
                {header("atime", "마지막 접근일", "w-[11%]")}
                {header("safety", "안전도", "w-[11%]")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const v = val(r);
                const pct = percent(v, total);
                const verdict = classifyPath(r.path);
                const meta = LEVEL_META[verdict.level];
                const isSel = selected?.id === r.id;
                return (
                  <tr
                    key={r.id}
                    onClick={() => select(r)}
                    onDoubleClick={() => {
                      if (r.isDir) void navigate(r.id);
                      else if (r.parent !== undefined && r.parent !== 0xffffffff) void navigate(r.parent);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      select(r);
                      set({ ctxMenu: { x: e.clientX, y: e.clientY, item: r } });
                    }}
                    className={`cursor-pointer border-b border-slate-800/50 ${
                      isSel ? "bg-sky-500/15" : "hover:bg-slate-800/50"
                    }`}
                  >
                    <td className="truncate px-3 py-1 text-slate-100">
                      {r.isDir ? (
                        <Folder className="mr-1.5 inline h-3.5 w-3.5 text-amber-400" />
                      ) : (
                        <File className="mr-1.5 inline h-3.5 w-3.5 text-slate-500" />
                      )}
                      {r.name}
                    </td>
                    <td className="truncate px-3 py-1 text-slate-500" title={r.path}>
                      {r.path}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-sky-300">{formatBytes(v)}</td>
                    <td className="px-3 py-1">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500"
                            style={{ width: `${Math.max(pct, 0.5)}%` }}
                          />
                        </div>
                        <span className="w-11 text-right tabular-nums text-slate-400">{pct.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-1 tabular-nums text-slate-400">{formatDate(r.atime)}</td>
                    <td className="px-3 py-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] ${meta.badge}`}
                        title={verdict.title}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        {meta.short}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-600">
                    {tab === "search" ? "검색 결과가 없습니다." : "표시할 항목이 없습니다. 먼저 스캔을 실행하세요."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
