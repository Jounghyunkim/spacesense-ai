import type { Metric, ViewNode } from "../types";
import { joinPath } from "./format";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified Treemap (Bruls, Huizing, van Wijk) 순수 함수.
 * `values` 는 내림차순으로 정렬된 양수 배열이어야 하며, 같은 순서의 사각형을 반환한다.
 * 한 줄(row)에 항목을 추가하다가 최악 종횡비가 나빠지는 순간 줄을 확정하고,
 * 남은 영역의 짧은 변을 따라 다음 줄을 배치한다.
 */
export function squarify(values: number[], rect: Rect): Rect[] {
  const n = values.length;
  const out: Rect[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += values[i];
  if (n === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) {
    for (let i = 0; i < n; i++) out[i] = { x: rect.x, y: rect.y, w: 0, h: 0 };
    return out;
  }
  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < n) {
    const side = Math.min(w, h);
    const side2 = side * side;
    let rowSum = 0;
    let rowMin = Infinity;
    let rowMax = 0;
    let best = Infinity;
    let j = i;
    while (j < n) {
      const a = values[j] * scale;
      const s = rowSum + a;
      const mx = Math.max(rowMax, a);
      const mn = Math.min(rowMin, a);
      const worst = Math.max((side2 * mx) / (s * s), (s * s) / (side2 * mn));
      if (j > i && worst > best) break;
      rowSum = s;
      rowMax = mx;
      rowMin = mn;
      best = worst;
      j++;
    }
    const thick = side > 0 ? rowSum / side : 0;
    if (w >= h) {
      // 왼쪽에 세로 줄
      let cy = y;
      for (let k = i; k < j; k++) {
        const hh = thick > 0 ? (values[k] * scale) / thick : 0;
        out[k] = { x, y: cy, w: thick, h: hh };
        cy += hh;
      }
      x += thick;
      w -= thick;
    } else {
      // 위쪽에 가로 줄
      let cx = x;
      for (let k = i; k < j; k++) {
        const ww = thick > 0 ? (values[k] * scale) / thick : 0;
        out[k] = { x: cx, y, w: ww, h: thick };
        cx += ww;
      }
      y += thick;
      h -= thick;
    }
    i = j;
  }
  return out;
}

export type ItemKind = "dir" | "file" | "other";

/** 화면에 배치된 한 블록 */
export interface LaidOut extends Rect {
  kind: ItemKind;
  /** other 블록이면 소속 폴더 노드 */
  node: ViewNode;
  parent: ViewNode | null;
  path: string;
  depth: number;
  /** true 면 색이 채워지는 말단 블록, false 면 하위를 품은 폴더 프레임 */
  leaf: boolean;
  header: boolean;
  value: number;
  /** other 블록에 병합된 항목 수 */
  count: number;
}

export const HEADER_H = 17;
const PAD = 2;

export function metricOf(n: ViewNode, metric: Metric): number {
  return metric === "alloc" ? n.alloc : n.size;
}

/**
 * 중첩 Treemap 레이아웃. 부모가 먼저, 자식이 나중에 오는 순서(그리기 순서)로 반환한다.
 * 너무 작은 항목은 `(Other small files)` 블록 하나로 병합한다.
 */
export function layoutTree(
  root: ViewNode,
  rootPath: string,
  rect: Rect,
  maxDepth: number,
  metric: Metric,
): LaidOut[] {
  const out: LaidOut[] = [];
  const rootValue = metricOf(root, metric);
  if (rootValue <= 0 || rect.w < 4 || rect.h < 4) return out;
  // 화면에서 약 4x4px 미만이 되는 항목은 병합한다.
  const minValue = (rootValue * 16) / (rect.w * rect.h);

  const place = (
    node: ViewNode,
    parent: ViewNode | null,
    path: string,
    r: Rect,
    depth: number,
  ) => {
    const kids = node.children;
    const expandable =
      node.isDir && kids !== undefined && depth < maxDepth && (depth === 0 || (r.w >= 28 && r.h >= 28));
    if (!expandable) {
      out.push({
        ...r,
        kind: node.isDir ? "dir" : "file",
        node,
        parent,
        path,
        depth,
        leaf: true,
        header: false,
        value: metricOf(node, metric),
        count: 0,
      });
      return;
    }
    let inner = r;
    if (depth > 0) {
      const header = r.w >= 64 && r.h >= 40;
      out.push({
        ...r,
        kind: "dir",
        node,
        parent,
        path,
        depth,
        leaf: false,
        header,
        value: metricOf(node, metric),
        count: 0,
      });
      const top = header ? HEADER_H : PAD;
      inner = { x: r.x + PAD, y: r.y + top, w: r.w - PAD * 2, h: r.h - top - PAD };
      if (inner.w < 4 || inner.h < 4) return;
    }
    let otherValue = metric === "alloc" ? node.otherAlloc : node.otherSize;
    let otherCount = node.otherCount;
    const shown: ViewNode[] = [];
    for (const k of kids!) {
      const v = metricOf(k, metric);
      if (v >= minValue && v > 0) shown.push(k);
      else {
        otherValue += v;
        otherCount++;
      }
    }
    type Entry = { v: number; n: ViewNode | null };
    const entries: Entry[] = shown.map((n) => ({ v: metricOf(n, metric), n }));
    if (otherValue > 0) entries.push({ v: otherValue, n: null });
    entries.sort((a, b) => b.v - a.v);
    const rects = squarify(
      entries.map((e) => e.v),
      inner,
    );
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const rr = rects[i];
      if (rr.w < 1 || rr.h < 1) continue;
      if (e.n === null) {
        out.push({
          ...rr,
          kind: "other",
          node,
          parent: node,
          path,
          depth: depth + 1,
          leaf: true,
          header: false,
          value: e.v,
          count: otherCount,
        });
      } else {
        place(e.n, node, joinPath(path, e.n.name), rr, depth + 1);
      }
    }
  };

  place(root, null, rootPath, rect, 0);
  return out;
}

/** 좌표에 있는 가장 깊은 블록을 찾는다. */
export function hitTest(items: LaidOut[], x: number, y: number): LaidOut | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h) return it;
  }
  return null;
}
