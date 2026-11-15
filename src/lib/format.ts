const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

export function formatDate(unixSecs: number): string {
  if (!unixSecs) return "-";
  const d = new Date(unixSecs * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}초`;
  return `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.min(100, (part * 100) / total) : 0;
}

export function joinPath(parent: string, name: string): string {
  return parent.endsWith("\\") ? parent + name : `${parent}\\${name}`;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("\\");
  if (i <= 2) return path.slice(0, 3);
  return path.slice(0, i);
}
