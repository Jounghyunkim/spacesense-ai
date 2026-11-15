import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  FolderSearch,
  Info,
  Loader2,
  Trash2,
  X,
  XCircle,
  Zap,
  ZoomIn,
} from "lucide-react";
import { api, errorText } from "../lib/api";
import { formatBytes, formatCount } from "../lib/format";
import { classifyPath, isTrashBlocked } from "../services/storageAdvisor";
import { useStore } from "../store";
import type { CacheTarget, CleanResult, Provider, Settings } from "../types";

function Modal({
  title,
  icon,
  onClose,
  width = "w-[520px]",
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-slate-950/70 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${width} max-h-[86vh] overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl flex flex-col`}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-800/80 px-4">
          {icon}
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.ctxMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => useStore.getState().set({ ctxMenu: null });
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);

  if (!menu) return null;
  const { item } = menu;
  const st = useStore.getState();
  const blocked = isTrashBlocked(classifyPath(item.path));
  const run = (fn: () => void) => () => {
    st.set({ ctxMenu: null });
    fn();
  };
  const row = (icon: React.ReactNode, label: string, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <button
      onClick={onClick}
      disabled={opts?.disabled}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] disabled:cursor-not-allowed disabled:opacity-40 ${
        opts?.danger ? "text-rose-300 hover:bg-rose-500/15" : "text-slate-200 hover:bg-slate-800"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-[270px] overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900/95 py-1 shadow-2xl backdrop-blur-md"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="truncate border-b border-slate-800/80 px-3 py-1.5 text-[11px] text-slate-500">{item.name}</div>
      {row(
        <Bot className="h-4 w-4 text-sky-400" />,
        `AI에게 이 ${item.isDir ? "폴더" : "파일"} 삭제해도 되는지 묻기`,
        run(() => void st.analyze(item)),
      )}
      {item.isDir &&
        row(<ZoomIn className="h-4 w-4 text-slate-400" />, "이 폴더로 확대 (Zoom in)", run(() => void st.navigate(item.id)))}
      {row(
        <FolderSearch className="h-4 w-4 text-slate-400" />,
        "Windows 탐색기에서 열기",
        run(() => void st.openInExplorer(item.path)),
      )}
      {row(<Copy className="h-4 w-4 text-slate-400" />, "경로 복사", run(() => void st.copyText(item.path)))}
      <div className="my-1 border-t border-slate-800/80" />
      {row(
        <Trash2 className="h-4 w-4" />,
        blocked ? "휴지통으로 이동 (보호된 항목)" : "휴지통으로 안전하게 이동",
        run(() => st.requestTrash(item)),
        { danger: true, disabled: blocked },
      )}
    </div>
  );
}

export function ConfirmDialog() {
  const req = useStore((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  if (!req) return null;
  const close = () => !busy && useStore.getState().set({ confirm: null });
  return (
    <Modal
      title={req.title}
      icon={<AlertTriangle className={`h-4 w-4 ${req.danger ? "text-rose-400" : "text-amber-400"}`} />}
      onClose={close}
      width="w-[460px]"
    >
      <div className="p-4">
        <p className="text-[13px] text-slate-100">{req.message}</p>
        {req.detail && (
          <p className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-slate-950/70 p-2.5 text-[11px] leading-relaxed text-slate-400">
            {req.detail}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={close}
            disabled={busy}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-800"
          >
            취소
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await req.onConfirm();
              } finally {
                setBusy(false);
                useStore.getState().set({ confirm: null });
              }
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-white ${
              req.danger ? "bg-rose-600 hover:bg-rose-500" : "bg-sky-600 hover:bg-sky-500"
            }`}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto flex max-w-[640px] cursor-pointer items-start gap-2 rounded-xl border px-3.5 py-2 text-[12px] shadow-2xl backdrop-blur-md ${
            t.kind === "error"
              ? "border-rose-500/40 bg-rose-950/90 text-rose-100"
              : t.kind === "success"
                ? "border-emerald-500/40 bg-emerald-950/90 text-emerald-100"
                : "border-slate-700 bg-slate-900/95 text-slate-100"
          }`}
        >
          {t.kind === "error" ? (
            <XCircle className="mt-px h-4 w-4 shrink-0" />
          ) : t.kind === "success" ? (
            <CheckCircle2 className="mt-px h-4 w-4 shrink-0" />
          ) : (
            <Info className="mt-px h-4 w-4 shrink-0" />
          )}
          <span className="leading-snug">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function SettingsModal() {
  const show = useStore((s) => s.showSettings);
  const saved = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [form, setForm] = useState<Settings>(saved);

  useEffect(() => {
    if (show) setForm(saved);
  }, [show, saved]);

  if (!show) return null;
  const close = () => useStore.getState().set({ showSettings: false });
  const up = (patch: Partial<Settings>) => setForm((f) => ({ ...f, ...patch }));

  const field = (label: string, value: string, onChange: (v: string) => void, opts?: { password?: boolean; placeholder?: string }) => (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-400">{label}</span>
      <input
        type={opts?.password ? "password" : "text"}
        value={value}
        placeholder={opts?.placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        className="h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 font-mono text-[12px] text-slate-100 outline-none placeholder:text-slate-700 focus:border-sky-500"
      />
    </label>
  );

  const providers: { id: Provider; name: string; desc: string }[] = [
    { id: "ollama", name: "Ollama (로컬)", desc: "데이터가 PC 밖으로 나가지 않음" },
    { id: "openai", name: "OpenAI", desc: "OpenAI 호환 API" },
    { id: "anthropic", name: "Claude", desc: "Anthropic API" },
  ];

  return (
    <Modal title="LLM 설정" icon={<Bot className="h-4 w-4 text-sky-400" />} onClose={close}>
      <div className="space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => up({ provider: p.id })}
              className={`rounded-xl border p-2.5 text-left ${
                form.provider === p.id
                  ? "border-sky-500 bg-sky-500/10"
                  : "border-slate-800 bg-slate-950/50 hover:border-slate-700"
              }`}
            >
              <div className="text-[12px] font-semibold text-slate-100">{p.name}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{p.desc}</div>
            </button>
          ))}
        </div>

        {form.provider === "ollama" && (
          <div className="space-y-3">
            {field("Ollama 엔드포인트", form.ollamaUrl, (v) => up({ ollamaUrl: v }), { placeholder: "http://localhost:11434" })}
            {field("모델", form.ollamaModel, (v) => up({ ollamaModel: v }), { placeholder: "llama3.1" })}
            <p className="text-[11px] leading-relaxed text-slate-500">
              Ollama 가 실행 중이어야 하며, 모델은 <code className="text-sky-300">ollama pull {form.ollamaModel || "llama3.1"}</code> 로 미리 받아 두세요.
            </p>
          </div>
        )}
        {form.provider === "openai" && (
          <div className="space-y-3">
            {field("API Key", form.openaiKey, (v) => up({ openaiKey: v }), { password: true, placeholder: "sk-..." })}
            {field("모델", form.openaiModel, (v) => up({ openaiModel: v }))}
            {field("Base URL (OpenAI 호환 서버 사용 시 변경)", form.openaiBaseUrl, (v) => up({ openaiBaseUrl: v }))}
          </div>
        )}
        {form.provider === "anthropic" && (
          <div className="space-y-3">
            {field("Claude API Key", form.anthropicKey, (v) => up({ anthropicKey: v }), { password: true, placeholder: "sk-ant-..." })}
            {field("모델", form.anthropicModel, (v) => up({ anthropicModel: v }), { placeholder: "claude-opus-5-5" })}
          </div>
        )}

        <p className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-[11px] leading-relaxed text-slate-500">
          API 키는 Windows DPAPI 로 암호화되어 이 PC 의 현재 사용자 계정에만 저장됩니다.
          {form.provider !== "ollama" &&
            " AI 분석/채팅 시 선택 항목의 경로, 확장자 분포, 파일명 샘플과 상위 폴더 요약이 해당 클라우드 API 로 전송됩니다."}
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={close} className="rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-800">
            취소
          </button>
          <button
            onClick={() => void saveSettings(form)}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500"
          >
            저장
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function QuickCleanModal() {
  const show = useStore((s) => s.showQuickClean);
  const elevated = useStore((s) => s.elevated);
  const [targets, setTargets] = useState<CacheTarget[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CleanResult | null>(null);

  const load = async () => {
    setTargets(null);
    setResult(null);
    setConfirming(false);
    try {
      const list = await api.scanSafeCaches();
      list.sort((a, b) => b.size - a.size);
      setTargets(list);
      setChecked(new Set(list.filter((t) => t.defaultChecked).map((t) => t.id)));
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
      setTargets([]);
    }
  };

  useEffect(() => {
    if (show) void load();
  }, [show]);

  if (!show) return null;
  const close = () => !busy && useStore.getState().set({ showQuickClean: false });
  const selectedSize = (targets ?? []).filter((t) => checked.has(t.id)).reduce((a, t) => a + t.size, 0);

  const clean = async () => {
    setBusy(true);
    try {
      const r = await api.cleanSafeCaches([...checked]);
      setResult(r);
      const st = useStore.getState();
      void st.refreshDrives();
      const list = await api.scanSafeCaches();
      list.sort((a, b) => b.size - a.size);
      setTargets(list);
      setChecked(new Set());
      if (st.hasScan) st.toast("info", "정리가 끝났습니다. [새로고침]으로 다시 스캔하면 Treemap 에 반영됩니다.");
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Modal
      title="원클릭 급속 공간 확보 — Safe Cache 스캔"
      icon={<Zap className="h-4 w-4 text-emerald-400" />}
      onClose={close}
      width="w-[640px]"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {targets === null ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
            안전하게 지울 수 있는 캐시를 찾는 중…
          </div>
        ) : (
          <>
            {result && (
              <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  <strong>{formatBytes(result.freed)}</strong> 확보 · 파일 {formatCount(result.deleted)}개 삭제
                  {result.failed > 0 && ` · 사용 중이거나 권한이 없어 건너뜀 ${formatCount(result.failed)}개`}
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
              {targets.length === 0 && (
                <p className="py-10 text-center text-[13px] text-slate-500">정리할 캐시가 없습니다. 이미 깨끗합니다!</p>
              )}
              {targets.map((t) => {
                const on = checked.has(t.id);
                return (
                  <label
                    key={t.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-2.5 ${
                      on ? "border-emerald-500/50 bg-emerald-500/5" : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={() => {
                        const n = new Set(checked);
                        if (on) n.delete(t.id);
                        else n.add(t.id);
                        setChecked(n);
                      }}
                      className="mt-0.5 h-4 w-4 accent-emerald-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium text-slate-100">
                        {t.label}
                        {t.needsAdmin && !elevated && (
                          <span className="rounded border border-amber-500/40 px-1 text-[10px] font-normal text-amber-300" title="일반 권한에서는 일부만 삭제됩니다">
                            관리자 권한 시 완전 정리
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] leading-snug text-slate-500">{t.description}</div>
                      {t.paths.length > 0 && (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-600" title={t.paths.join("\n")}>
                          {t.paths[0]}
                          {t.paths.length > 1 && ` 외 ${t.paths.length - 1}곳`}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[13px] font-semibold tabular-nums text-emerald-300">{formatBytes(t.size)}</div>
                      <div className="text-[10px] text-slate-500">{formatCount(t.files)}개</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-3 border-t border-slate-800/80 p-4">
              <div className="text-[12px] text-slate-400">
                선택 항목 합계{" "}
                <span className="text-base font-semibold text-emerald-300">{formatBytes(selectedSize)}</span>
              </div>
              <div className="flex-1" />
              {confirming ? (
                <>
                  <span className="text-[11px] text-rose-300">영구 삭제되며 복구할 수 없습니다.</span>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-800"
                  >
                    취소
                  </button>
                  <button
                    onClick={() => void clean()}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-rose-500"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {busy ? "정리 중…" : "삭제 확정"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void load()}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-800"
                  >
                    다시 검사
                  </button>
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={checked.size === 0 || selectedSize === 0}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    선택 항목 정리
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
