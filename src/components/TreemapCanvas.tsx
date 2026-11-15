import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { formatBytes, formatCount, percent } from "../lib/format";
import { buildMatcher } from "../lib/search";
import { HEADER_H, hitTest, layoutTree, metricOf, type LaidOut, type Rect } from "../lib/treemap";
import { CATEGORY_META, LEVEL_META, categoryOf, classifyPath } from "../services/storageAdvisor";
import { useStore } from "../store";
import type { ColorMode, Selected } from "../types";

const FONT = '11px "Segoe UI", "Malgun Gothic", system-ui, sans-serif';
const BG = "#020617";

/** 16진 색을 밝게(f>0) 또는 어둡게(f<0) 조정 */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const adj = (c: number) =>
    Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f));
  const r = adj((n >> 16) & 255);
  const g = adj((n >> 8) & 255);
  const b = adj(n & 255);
  return `rgb(${r},${g},${b})`;
}

function leafColor(it: LaidOut, mode: ColorMode): string {
  if (it.kind === "other") return "#334155";
  if (mode === "safety") return LEVEL_META[classifyPath(it.path).level].color;
  return CATEGORY_META[categoryOf(it.path, it.node.name, it.node.isDir)].color;
}

function itemToSelected(it: LaidOut): Selected {
  // other 블록은 소속 폴더를 선택한다.
  const n = it.node;
  return {
    id: n.id,
    name: n.name,
    path: it.path,
    isDir: n.isDir,
    size: n.size,
    alloc: n.alloc,
    files: n.files,
    dirs: n.dirs,
    mtime: n.mtime,
    atime: n.atime,
  };
}

/** 정적 레이아웃 전체를 오프스크린 캔버스에 그린다. */
function renderBase(
  ctx: CanvasRenderingContext2D,
  items: LaidOut[],
  w: number,
  h: number,
  mode: ColorMode,
  matcher: ReturnType<typeof buildMatcher>,
) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.font = FONT;
  ctx.textBaseline = "middle";

  for (const it of items) {
    const { x, y } = it;
    const bw = it.w;
    const bh = it.h;
    if (!it.leaf) {
      // 폴더 프레임: 깊이에 따라 조금씩 밝아지는 배경 + 헤더
      const tone = ["#0b1220", "#111a2e", "#16213a", "#1b2946"][Math.min(3, it.depth - 1)];
      ctx.fillStyle = tone;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = "rgba(100,116,139,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
      if (it.header) {
        ctx.fillStyle = "rgba(30,41,59,0.95)";
        ctx.fillRect(x + 1, y + 1, bw - 2, HEADER_H - 2);
        const size = formatBytes(it.value);
        const sizeW = ctx.measureText(size).width;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 4, y, Math.max(0, bw - 12 - sizeW), HEADER_H);
        ctx.clip();
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(it.node.name, x + 5, y + HEADER_H / 2);
        ctx.restore();
        if (bw > sizeW + 40) {
          ctx.fillStyle = "#7dd3fc";
          ctx.fillText(size, x + bw - sizeW - 5, y + HEADER_H / 2);
        }
      }
      continue;
    }

    const base = leafColor(it, mode);
    const dim =
      matcher !== null &&
      (it.kind === "other" || !matcher(it.node.name, it.node.size, it.node.isDir));
    ctx.globalAlpha = dim ? 0.16 : 1;
    // 인접 블록 구분을 위한 미세한 명도 변화
    const variation = it.kind === "other" ? 0 : ((it.node.id * 37) % 9) / 100 - 0.04;
    ctx.fillStyle = shade(base, variation);
    ctx.fillRect(x, y, bw, bh);
    if (bw * bh > 500) {
      // Cushion 음영: 좌상단 하이라이트 -> 우하단 그림자
      const g = ctx.createLinearGradient(x, y, x + bw, y + bh);
      g.addColorStop(0, "rgba(255,255,255,0.24)");
      g.addColorStop(0.45, "rgba(255,255,255,0.02)");
      g.addColorStop(1, "rgba(0,0,0,0.34)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, bw, bh);
    }
    if (bw > 3 && bh > 3) {
      ctx.strokeStyle = "rgba(2,6,23,0.75)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    }
    if (bw > 44 && bh > 15) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y + 1, bw - 5, bh - 2);
      ctx.clip();
      const twoLine = bh > 32;
      const label = it.kind === "other" ? `(Other small files · ${formatCount(it.count)})` : it.node.name;
      ctx.fillStyle = "rgba(2,6,23,0.55)";
      ctx.fillText(label, x + 6, y + (twoLine ? 11 : bh / 2) + 1);
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(label, x + 5, y + (twoLine ? 11 : bh / 2));
      if (twoLine) {
        ctx.fillStyle = "rgba(248,250,252,0.78)";
        ctx.fillText(formatBytes(it.value), x + 5, y + 25);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

export default function TreemapCanvas() {
  const view = useStore((s) => s.view);
  const depth = useStore((s) => s.depth);
  const metric = useStore((s) => s.metric);
  const colorMode = useStore((s) => s.colorMode);
  const search = useStore((s) => s.search);
  const selected = useStore((s) => s.selected);
  const scanning = useStore((s) => s.scanning);
  const hasScan = useStore((s) => s.hasScan);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const lastRootRef = useRef<number>(-1);
  const animRef = useRef<number>(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ item: LaidOut; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = useMemo(() => {
    if (!view || size.w < 8 || size.h < 8) return [];
    return layoutTree(view.root, view.path, { x: 0, y: 0, w: size.w, h: size.h }, depth, metric);
  }, [view, size.w, size.h, depth, metric]);

  const matcher = useMemo(() => buildMatcher(search), [search]);

  // 정적 레이어 렌더링 (+ 줌 인 애니메이션)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w < 8 || size.h < 8) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(size.w * dpr);
    const ph = Math.round(size.h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const base = baseRef.current ?? (baseRef.current = document.createElement("canvas"));
    if (base.width !== pw || base.height !== ph) {
      base.width = pw;
      base.height = ph;
    }
    const bctx = base.getContext("2d")!;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderBase(bctx, items, size.w, size.h, colorMode, matcher);

    const ctx = canvas.getContext("2d")!;
    cancelAnimationFrame(animRef.current);
    const rootId = view?.root.id ?? -1;
    const from: Rect | null = rootId !== lastRootRef.current ? useStore.getState().zoomFrom : null;
    const rootChanged = rootId !== lastRootRef.current;
    lastRootRef.current = rootId;
    if (rootChanged) useStore.getState().consumeZoom();

    const blit = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(base, 0, 0);
    };
    if (!from || items.length === 0) {
      blit();
      return;
    }
    // 더블클릭한 블록의 사각형이 전체 화면으로 펼쳐지는 전환
    const start = performance.now();
    const DURATION = 260;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      const x = from.x * (1 - e);
      const y = from.y * (1 - e);
      const w = from.w + (size.w - from.w) * e;
      const h = from.h + (size.h - from.h) * e;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, pw, ph);
      ctx.globalAlpha = 0.25 + 0.75 * e;
      ctx.drawImage(base, x * dpr, y * dpr, w * dpr, h * dpr);
      if (t < 1) animRef.current = requestAnimationFrame(step);
      else blit();
    };
    animRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animRef.current);
  }, [items, size.w, size.h, colorMode, matcher, view]);

  // 호버/선택 하이라이트 레이어
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || size.w < 8) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(size.w * dpr);
    const ph = Math.round(size.h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (selected) {
      const it = items.find((i) => i.kind !== "other" && i.node.id === selected.id);
      if (it) {
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(it.x + 1.25, it.y + 1.25, it.w - 2.5, it.h - 2.5);
        ctx.fillStyle = "rgba(34,211,238,0.10)";
        ctx.fillRect(it.x, it.y, it.w, it.h);
      }
    }
    if (hover) {
      const it = hover.item;
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(it.x + 0.75, it.y + 0.75, it.w - 1.5, it.h - 1.5);
    }
  }, [hover, selected, items, size.w, size.h]);

  const pick = useCallback(
    (e: React.MouseEvent) => {
      const r = wrapRef.current!.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      return { item: hitTest(items, x, y), x, y };
    },
    [items],
  );

  const onMove = (e: React.MouseEvent) => {
    const { item, x, y } = pick(e);
    setHover(item ? { item, x, y } : null);
  };

  const onClick = (e: React.MouseEvent) => {
    const { item } = pick(e);
    useStore.getState().set({ ctxMenu: null });
    if (item) useStore.getState().select(itemToSelected(item));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { item } = pick(e);
    if (!item || !view) return;
    const st = useStore.getState();
    // 폴더면 그 폴더로, 파일/병합 블록이면 소속 폴더로 줌 인
    let target: LaidOut | undefined = item;
    if (item.kind === "other") target = items.find((i) => i.kind === "dir" && i.node.id === item.node.id);
    else if (item.kind === "file")
      target = items.find((i) => i.kind === "dir" && item.parent !== null && i.node.id === item.parent.id);
    const id = target ? target.node.id : item.kind === "file" ? item.parent?.id : item.node.id;
    if (id === undefined || id === view.root.id) return;
    const from = target ?? item;
    void st.navigate(id, { x: from.x, y: from.y, w: from.w, h: from.h });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { item } = pick(e);
    if (!item) return;
    setHover(null);
    const sel = itemToSelected(item);
    const st = useStore.getState();
    st.select(sel);
    st.set({ ctxMenu: { x: e.clientX, y: e.clientY, item: sel } });
  };

  const rootValue = view ? metricOf(view.root, metric) : 0;
  const tip = hover?.item;
  const tipLeft = hover ? Math.min(hover.x + 16, Math.max(8, size.w - 330)) : 0;
  const tipTop = hover ? (hover.y + 150 > size.h ? Math.max(8, hover.y - 130) : hover.y + 18) : 0;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden rounded-xl bg-slate-950"
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 h-full w-full cursor-pointer"
        onMouseMove={onMove}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />

      {items.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
          {scanning ? (
            <>
              <Loader2 className="h-9 w-9 animate-spin text-sky-400" />
              <p className="text-sm">디스크를 스캔하는 중…</p>
            </>
          ) : hasScan && view ? (
            <>
              <HardDrive className="h-10 w-10" />
              <p className="text-sm">이 폴더에는 표시할 항목이 없습니다.</p>
            </>
          ) : (
            <>
              <HardDrive className="h-12 w-12 text-slate-600" />
              <p className="text-base font-medium text-slate-300">드라이브를 선택하고 [스캔 시작]을 누르세요</p>
              <p className="text-xs">
                클릭: 선택 · 더블클릭: 폴더로 확대 · 우클릭: 메뉴
              </p>
            </>
          )}
        </div>
      )}

      {tip && (
        <div
          className="pointer-events-none absolute z-10 w-[310px] rounded-lg border border-slate-700/80 bg-slate-900/95 p-2.5 text-xs shadow-xl backdrop-blur"
          style={{ left: tipLeft, top: tipTop }}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: tip.leaf ? leafColor(tip, colorMode) : "#64748b" }}
            />
            <span className="truncate font-semibold text-slate-100">
              {tip.kind === "other" ? `(Other small files) — ${tip.node.name}` : tip.node.name}
            </span>
          </div>
          <div className="mb-1.5 break-all text-[11px] text-slate-400">{tip.path}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-300">
            <span className="text-slate-500">용량</span>
            <span className="text-right font-medium text-sky-300">{formatBytes(tip.value)}</span>
            <span className="text-slate-500">현재 보기 대비</span>
            <span className="text-right">{percent(tip.value, rootValue).toFixed(2)}%</span>
            {tip.kind === "other" ? (
              <>
                <span className="text-slate-500">병합된 항목</span>
                <span className="text-right">{formatCount(tip.count)}개</span>
              </>
            ) : tip.node.isDir ? (
              <>
                <span className="text-slate-500">파일 / 폴더</span>
                <span className="text-right">
                  {formatCount(tip.node.files)} / {formatCount(tip.node.dirs)}
                </span>
              </>
            ) : null}
            {tip.kind !== "other" && (
              <>
                <span className="text-slate-500">안전도</span>
                <span className="text-right">{LEVEL_META[classifyPath(tip.path).level].label}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
