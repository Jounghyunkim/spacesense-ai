import { useEffect, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  FolderOpen,
  HardDrive,
  Layers,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import { api, errorText } from "../lib/api";
import { formatBytes, percent } from "../lib/format";
import { useStore } from "../store";

function DriveSelector() {
  const drives = useStore((s) => s.drives);
  const rootPath = useStore((s) => s.rootPath);
  const setRootPath = useStore((s) => s.setRootPath);
  const pickFolder = useStore((s) => s.pickFolder);

  const drive = drives.find((d) => rootPath.toUpperCase().startsWith(d.path.toUpperCase()));
  const used = drive ? drive.total - drive.free : 0;
  const pct = drive ? percent(used, drive.total) : 0;
  const isCustom = !drives.some((d) => d.path === rootPath) && rootPath !== "";
  const barColor = pct >= 90 ? "bg-rose-500" : pct >= 75 ? "bg-amber-400" : "bg-sky-500";

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <HardDrive className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-400" />
        <select
          value={rootPath}
          onChange={(e) => {
            if (e.target.value === "__pick__") void pickFolder();
            else setRootPath(e.target.value);
          }}
          className="h-9 w-[330px] cursor-pointer appearance-none rounded-lg border border-slate-800/80 bg-slate-900 pl-8 pr-3 text-[13px] text-slate-100 outline-none hover:border-slate-700 focus:border-sky-500"
        >
          {drives.map((d) => {
            const u = d.total - d.free;
            return (
              <option key={d.path} value={d.path}>
                {d.path} {d.label ? `[${d.label}] ` : ""}({formatBytes(u)} / {formatBytes(d.total)} -{" "}
                {percent(u, d.total).toFixed(1)}% 사용 중)
              </option>
            );
          })}
          {isCustom && <option value={rootPath}>📁 {rootPath}</option>}
          <option value="__pick__">폴더 선택…</option>
        </select>
      </div>
      {drive && (
        <div className="w-28" title={`${formatBytes(drive.free)} 남음`}>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-0.5 text-[10px] leading-none text-slate-400">
            {formatBytes(drive.free)} 남음
          </div>
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const total = useStore((s) => s.searchTotal);
  const [text, setText] = useState(search);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== useStore.getState().search) void setSearch(text);
    }, 250);
    return () => clearTimeout(t);
  }, [text, setSearch]);

  return (
    <div className="relative min-w-[180px] flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="검색: *.vhdx  *.log  >1GB  node_modules"
        spellCheck={false}
        className="h-9 w-full rounded-lg border border-slate-800/80 bg-slate-900 pl-8 pr-20 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 hover:border-slate-700 focus:border-sky-500"
      />
      {text && (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {search && <span className="text-[11px] text-slate-400">{total.toLocaleString()}건</span>}
          <button
            onClick={() => setText("")}
            className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="검색 지우기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function HeaderBar() {
  const scanning = useStore((s) => s.scanning);
  const hasScan = useStore((s) => s.hasScan);
  const elevated = useStore((s) => s.elevated);
  const panelOpen = useStore((s) => s.panelOpen);
  const startScan = useStore((s) => s.startScan);
  const cancelScan = useStore((s) => s.cancelScan);
  const set = useStore((s) => s.set);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-800/80 bg-slate-900/60 px-4 backdrop-blur-md">
      <div className="mr-1 flex items-center gap-2">
        <div className="grid h-8 w-8 grid-cols-2 gap-0.5 rounded-lg bg-slate-800 p-1">
          <span className="rounded-sm bg-sky-500" />
          <span className="rounded-sm bg-purple-500" />
          <span className="rounded-sm bg-emerald-500" />
          <span className="rounded-sm bg-amber-500" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-slate-100">SpaceSense AI</div>
          <div className="text-[10px] text-slate-500">Disk Space Analyzer</div>
        </div>
      </div>

      <DriveSelector />

      {scanning ? (
        <button
          onClick={() => void cancelScan()}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-[13px] font-medium text-rose-300 hover:bg-rose-500/20"
        >
          <Square className="h-3.5 w-3.5 fill-current" />
          스캔 중지
        </button>
      ) : (
        <button
          onClick={() => void startScan()}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-sky-600 px-3 text-[13px] font-medium text-white shadow-lg shadow-sky-900/40 hover:bg-sky-500"
        >
          <RefreshCw className="h-4 w-4" />
          {hasScan ? "새로고침" : "스캔 시작"}
        </button>
      )}

      <button
        onClick={() => set({ showQuickClean: true })}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-[13px] font-medium text-emerald-300 hover:bg-emerald-500/20"
        title="안전한 캐시/임시 파일만 찾아 한 번에 정리합니다"
      >
        <Zap className="h-4 w-4" />
        원클릭 급속 공간 확보
      </button>

      <SearchBox />

      {elevated ? (
        <span
          className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300"
          title="관리자 권한으로 실행 중: 시스템 폴더까지 스캔됩니다"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          관리자
        </span>
      ) : (
        <button
          onClick={() =>
            set({
              confirm: {
                title: "관리자 권한으로 다시 시작",
                message: "관리자 권한으로 앱을 다시 시작할까요?",
                detail:
                  "일반 권한에서는 접근이 거부되는 시스템 폴더(System Volume Information, 다른 사용자 프로필 등)까지 스캔할 수 있습니다. 현재 스캔 결과는 사라집니다.",
                confirmLabel: "다시 시작",
                onConfirm: async () => {
                  try {
                    await api.restartAsAdmin();
                  } catch (e) {
                    useStore.getState().toast("error", errorText(e));
                  }
                },
              },
            })
          }
          className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] text-slate-300 hover:border-amber-500/50 hover:text-amber-300"
          title="일부 시스템 폴더는 관리자 권한이 있어야 스캔됩니다"
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          일반 권한
        </button>
      )}

      <button
        onClick={() => set({ showSettings: true })}
        className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        title="LLM 설정"
      >
        <SettingsIcon className="h-4.5 w-4.5" />
      </button>
      <button
        onClick={() => set({ panelOpen: !panelOpen })}
        className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        title={panelOpen ? "AI 패널 접기" : "AI 패널 펼치기"}
      >
        {panelOpen ? <PanelRightClose className="h-4.5 w-4.5" /> : <PanelRightOpen className="h-4.5 w-4.5" />}
      </button>
    </header>
  );
}

export function NavBar() {
  const view = useStore((s) => s.view);
  const depth = useStore((s) => s.depth);
  const metric = useStore((s) => s.metric);
  const colorMode = useStore((s) => s.colorMode);
  const navigate = useStore((s) => s.navigate);
  const navigateUp = useStore((s) => s.navigateUp);
  const setDepth = useStore((s) => s.setDepth);
  const setMetric = useStore((s) => s.setMetric);
  const setColorMode = useStore((s) => s.setColorMode);

  const crumbs = view?.crumbs ?? [];
  const canUp = crumbs.length >= 2;
  const seg = (active: boolean) =>
    `px-2.5 py-1 text-[12px] rounded-md transition-colors ${
      active ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-200"
    }`;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-slate-800/80 bg-slate-950 px-4">
      <button
        onClick={navigateUp}
        disabled={!canUp}
        className="flex h-7 items-center gap-1 rounded-md border border-slate-800/80 bg-slate-900 px-2 text-[12px] text-slate-300 hover:border-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        title="상위 폴더로"
      >
        <ArrowUp className="h-3.5 w-3.5" />
        Up
      </button>

      <nav className="flex min-w-0 flex-1 items-center overflow-x-auto text-[13px] [scrollbar-width:none]">
        {crumbs.length === 0 ? (
          <span className="flex items-center gap-1.5 text-slate-600">
            <FolderOpen className="h-4 w-4" /> 스캔 결과 없음
          </span>
        ) : (
          crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={c.id} className="flex shrink-0 items-center">
                {i > 0 && <ChevronRight className="mx-0.5 h-3.5 w-3.5 text-slate-600" />}
                <button
                  onClick={() => !last && void navigate(c.id)}
                  className={`rounded px-1.5 py-0.5 ${
                    last
                      ? "cursor-default font-semibold text-slate-100"
                      : "text-slate-400 hover:bg-slate-800 hover:text-sky-300"
                  }`}
                >
                  {c.name}
                </button>
              </span>
            );
          })
        )}
        {view && (
          <span className="ml-2 shrink-0 rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] text-sky-300">
            {formatBytes(metric === "alloc" ? view.root.alloc : view.root.size)}
          </span>
        )}
      </nav>

      <div className="flex items-center rounded-lg border border-slate-800/80 bg-slate-900 p-0.5" title="색상 기준">
        <button className={seg(colorMode === "category")} onClick={() => setColorMode("category")}>
          <Layers className="mr-1 inline h-3.5 w-3.5" />
          파일 종류
        </button>
        <button className={seg(colorMode === "safety")} onClick={() => setColorMode("safety")}>
          <Sparkles className="mr-1 inline h-3.5 w-3.5" />
          삭제 안전도
        </button>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-slate-400" title="중첩 표시 깊이">
        깊이
        <input
          type="range"
          min={1}
          max={4}
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          className="h-1 w-20 cursor-pointer accent-sky-500"
        />
        <span className="w-3 text-slate-200">{depth}</span>
      </label>

      <div
        className="flex items-center rounded-lg border border-slate-800/80 bg-slate-900 p-0.5"
        title="디스크 할당 크기: 클러스터 단위 실제 점유 / 논리 크기: 파일 내용 크기"
      >
        <button className={seg(metric === "alloc")} onClick={() => setMetric("alloc")}>
          디스크 할당
        </button>
        <button className={seg(metric === "size")} onClick={() => setMetric("size")}>
          논리 크기
        </button>
      </div>
    </div>
  );
}

export function StatusBar() {
  const stats = useStore((s) => s.stats);
  const scanning = useStore((s) => s.scanning);
  const hasScan = useStore((s) => s.hasScan);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-slate-800/80 bg-slate-900/70 px-4 text-[11px] text-slate-400">
      {!hasScan || !stats ? (
        <span>{scanning ? "스캔 준비 중…" : "준비됨"}</span>
      ) : (
        <>
          <span className="flex items-center gap-1.5">
            {scanning ? (
              <Loader2 className="h-3 w-3 animate-spin text-sky-400" />
            ) : (
              <span className={`h-1.5 w-1.5 rounded-full ${stats.cancelled ? "bg-amber-400" : "bg-emerald-400"}`} />
            )}
            {scanning ? "스캔 중" : stats.cancelled ? "중지됨 (부분 결과)" : "스캔 완료"}
          </span>
          <span>파일 {stats.files.toLocaleString()}</span>
          <span>폴더 {stats.dirs.toLocaleString()}</span>
          <span className="text-sky-300">{formatBytes(stats.bytes)}</span>
          <span>{(stats.elapsedMs / 1000).toFixed(1)}초</span>
          {stats.errors > 0 && (
            <span className="text-amber-400" title="접근이 거부된 폴더 수 (관리자 권한으로 실행하면 줄어듭니다)">
              접근 불가 {stats.errors.toLocaleString()}
            </span>
          )}
          {scanning && <span className="min-w-0 flex-1 truncate text-slate-600">{stats.current}</span>}
        </>
      )}
    </footer>
  );
}
