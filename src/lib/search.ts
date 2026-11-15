/** 검색 문법 (백엔드 scanner::search 와 동일): `*.vhdx`, `log`, `>1GB`, `<10MB` */
export interface Matcher {
  (name: string, size: number, isDir: boolean): boolean;
}

function parseSize(s: string): number | null {
  const m = /^([\d.]+)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(s.trim());
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return null;
  const unit = (m[2] ?? "b").toLowerCase()[0];
  const mult = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit] ?? 1;
  return num * mult;
}

export function buildMatcher(query: string): Matcher | null {
  const globs: RegExp[] = [];
  const subs: string[] = [];
  let min = 0;
  let max = Infinity;
  for (const tok of query.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith(">") || tok.startsWith("<")) {
      const v = parseSize(tok.slice(1).replace(/^=/, ""));
      if (v !== null) {
        if (tok[0] === ">") min = v;
        else max = v;
        continue;
      }
    }
    const low = tok.toLowerCase();
    if (low.includes("*") || low.includes("?")) {
      const re = low
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      globs.push(new RegExp(`^${re}$`));
    } else {
      subs.push(low);
    }
  }
  const nameFilter = globs.length > 0 || subs.length > 0;
  if (!nameFilter && min === 0 && max === Infinity) return null;
  return (name, size, isDir) => {
    if (isDir && !nameFilter) return false;
    if (size < min || size > max) return false;
    if (!nameFilter) return true;
    const low = name.toLowerCase();
    return subs.every((s) => low.includes(s)) && globs.every((g) => g.test(low));
  };
}
