import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Copy,
  File,
  Folder,
  FolderSearch,
  Loader2,
  MousePointerClick,
  Play,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { formatBytes, formatCount, formatDate, percent } from "../lib/format";
import {
  COMMANDS,
  LEVEL_META,
  classifyPath,
  isTrashBlocked,
  type AiAnalysis,
  type CleanupCommand,
} from "../services/storageAdvisor";
import { useStore } from "../store";
import type { Selected } from "../types";

const PROVIDER_LABEL = { ollama: "Ollama", openai: "OpenAI", anthropic: "Claude" } as const;

/** 채팅 답변용 초경량 마크다운 렌더러 (제목, 목록, 체크리스트, 굵게, 인라인 코드) */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-slate-50">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-slate-950 px-1 py-px font-mono text-[11px] text-sky-300">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let code: string[] | null = null;
  lines.forEach((line, i) => {
    if (line.trim().startsWith("```")) {
      if (code) {
        out.push(
          <pre key={i} className="my-1 overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] text-sky-200">
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else code = [];
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const check = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const li = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <div key={i} className="mt-2 mb-0.5 text-[13px] font-semibold text-slate-50">
          {inline(h[2])}
        </div>,
      );
    } else if (check) {
      out.push(
        <div key={i} className="flex gap-1.5 pl-1">
          <span className="mt-[3px] h-3 w-3 shrink-0 rounded-sm border border-slate-500 text-center text-[9px] leading-[10px] text-emerald-400">
            {check[1] !== " " ? "✓" : ""}
          </span>
          <span>{inline(check[2])}</span>
        </div>,
      );
    } else if (li) {
      out.push(
        <div key={i} className="flex gap-1.5" style={{ paddingLeft: 4 + li[1].length * 6 }}>
          <span className="shrink-0 text-slate-500">{/^\d/.test(li[2]) ? li[2] : "•"}</span>
          <span>{inline(li[3])}</span>
        </div>,
      );
    } else if (line.trim() === "") {
      out.push(<div key={i} className="h-1.5" />);
    } else {
      out.push(<div key={i}>{inline(line)}</div>);
    }
  });
  return <div className="space-y-0.5 break-words leading-relaxed">{out}</div>;
}

function CommandBox({ cmd }: { cmd: CleanupCommand }) {
  const copyText = useStore((s) => s.copyText);
  const runCommand = useStore((s) => s.runCommand);
  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-950/70 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
        {cmd.label}
        {cmd.admin && (
          <span className="rounded border border-amber-500/40 px-1 text-[10px] text-amber-300">관리자</span>
        )}
      </div>
      <code className="block break-all rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-sky-300">
        {cmd.command}
      </code>
      <div className="mt-1.5 flex gap-1.5">
        <button
          onClick={() => void copyText(cmd.command, "명령어")}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
        >
          <Copy className="h-3 w-3" /> 복사
        </button>
        {cmd.runnable && (
          <button
            onClick={() => runCommand(cmd.id, cmd.label)}
            className="flex items-center gap-1 rounded-md bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500"
          >
            <Play className="h-3 w-3 fill-current" /> 명령어 실행
          </button>
        )}
      </div>
    </div>
  );
}

function Inspector({ item }: { item: Selected }) {
  const view = useStore((s) => s.view);
  const copyText = useStore((s) => s.copyText);
  const openInExplorer = useStore((s) => s.openInExplorer);
  const requestTrash = useStore((s) => s.requestTrash);
  const navigate = useStore((s) => s.navigate);
  const verdict = classifyPath(item.path);
  const meta = LEVEL_META[verdict.level];
  const share = view ? percent(item.alloc, view.scanAlloc) : 0;
  const blocked = isTrashBlocked(verdict);

  const cell = (label: string, value: string, accent = false) => (
    <div className="rounded-lg bg-slate-950/60 px-2.5 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-[13px] font-medium tabular-nums ${accent ? "text-sky-300" : "text-slate-100"}`}>
        {value}
      </div>
    </div>
  );

  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/70 p-3">
      <div className="flex items-start gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-800">
          {item.isDir ? <Folder className="h-5 w-5 text-amber-400" /> : <File className="h-5 w-5 text-slate-300" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-50" title={item.name}>
            {item.name}
          </div>
          <button
            onClick={() => void copyText(item.path)}
            className="block w-full break-all text-left text-[11px] leading-snug text-slate-500 hover:text-sky-300"
            title="클릭하여 경로 복사"
          >
            {item.path}
          </button>
        </div>
      </div>

      <div className={`mt-2.5 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${meta.badge}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot} shadow-[0_0_8px_currentColor]`} />
        {meta.label}
        <span className="ml-auto truncate text-[11px] font-normal opacity-80">{verdict.title}</span>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        {cell("디스크 할당 크기", formatBytes(item.alloc), true)}
        {cell("논리 크기", formatBytes(item.size))}
        {cell("하위 파일 수", item.isDir ? formatCount(item.files) : "-")}
        {cell("하위 폴더 수", item.isDir ? formatCount(item.dirs) : "-")}
        {cell("마지막 수정일", formatDate(item.mtime))}
        {cell("스캔 전체 대비 점유율", `${share.toFixed(2)}%`)}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500"
          style={{ width: `${Math.max(share, 0.5)}%` }}
        />
      </div>

      <div className="mt-2.5 flex gap-1.5">
        <button
          onClick={() => void openInExplorer(item.path)}
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-700 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800"
        >
          <FolderSearch className="h-3.5 w-3.5" /> 탐색기
        </button>
        {item.isDir && (
          <button
            onClick={() => void navigate(item.id)}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-700 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800"
          >
            <ZoomIn className="h-3.5 w-3.5" /> 확대
          </button>
        )}
        <button
          onClick={() => requestTrash(item)}
          disabled={blocked}
          title={blocked ? "이 항목은 직접 삭제할 수 없습니다" : "휴지통으로 이동"}
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-rose-500/40 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600 disabled:hover:bg-transparent"
        >
          <Trash2 className="h-3.5 w-3.5" /> 휴지통
        </button>
      </div>
    </section>
  );
}

const AI_SAFETY = {
  safe: { label: "안전", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", Icon: ShieldCheck },
  caution: { label: "주의", cls: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40", Icon: AlertTriangle },
  danger: { label: "위험", cls: "bg-rose-500/15 text-rose-300 border-rose-500/40", Icon: ShieldX },
} as const;

function AnalysisResult({ a, item }: { a: AiAnalysis; item: Selected }) {
  const requestTrash = useStore((s) => s.requestTrash);
  const runCommand = useStore((s) => s.runCommand);
  const copyText = useStore((s) => s.copyText);
  const s = AI_SAFETY[a.safety];
  const cmd = a.action.commandId ? COMMANDS[a.action.commandId] : null;
  const ruleBlocked = isTrashBlocked(classifyPath(item.path));

  const block = (title: string, body: string) =>
    body ? (
      <div>
        <div className="mb-0.5 text-[11px] font-medium text-slate-400">{title}</div>
        <p className="text-[12px] leading-relaxed text-slate-200">{body}</p>
      </div>
    ) : null;

  return (
    <div className="space-y-2.5">
      <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold ${s.cls}`}>
        <s.Icon className="h-4 w-4" />
        삭제 안전도: {s.label}
      </div>
      {block("정체 분석", a.identity)}
      {block("삭제 시 영향", a.sideEffects)}
      {block("권장 조치", a.recommendation)}

      {a.action.type === "trash" && !ruleBlocked && (
        <button
          onClick={() => requestTrash(item)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-rose-600 py-2 text-[12px] font-medium text-white hover:bg-rose-500"
        >
          <Trash2 className="h-3.5 w-3.5" /> {a.action.label || "휴지통으로 이동"}
        </button>
      )}
      {a.action.type === "uninstall" && (
        <button
          onClick={() => runCommand("open_uninstall", COMMANDS.open_uninstall.label)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 py-2 text-[12px] font-medium text-white hover:bg-sky-500"
        >
          <SettingsIcon className="h-3.5 w-3.5" /> {a.action.label || "제어판 앱 제거 열기"}
        </button>
      )}
      {a.action.type === "command" && cmd && <CommandBox cmd={cmd} />}
      {a.action.type === "command" && !cmd && a.action.command && (
        <div className="rounded-lg border border-slate-800/80 bg-slate-950/70 p-2">
          <div className="mb-1 text-[11px] text-slate-400">
            {a.action.label || "AI 제안 명령"} — 내용을 확인한 뒤 직접 실행하세요
          </div>
          <code className="block break-all rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-sky-300">
            {a.action.command}
          </code>
          <button
            onClick={() => void copyText(a.action.command!, "명령어")}
            className="mt-1.5 flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            <Copy className="h-3 w-3" /> 전용 정리 명령어 복사
          </button>
        </div>
      )}
      <p className="text-[10px] leading-snug text-slate-600">
        AI 분석은 파일명·구조에 근거한 추정입니다. 중요한 데이터는 삭제 전에 직접 확인하세요.
      </p>
    </div>
  );
}

function AdvisorReport({ item }: { item: Selected }) {
  const ai = useStore((s) => s.ai);
  const analyze = useStore((s) => s.analyze);
  const set = useStore((s) => s.set);
  const verdict = classifyPath(item.path);
  const mine = ai.path === item.path;

  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/70 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-slate-200">
        <Sparkles className="h-4 w-4 text-sky-400" />
        분석 리포트
      </div>

      <p className="text-[12px] leading-relaxed text-slate-300">{verdict.message}</p>
      {verdict.commands.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {verdict.commands.map((c) => (
            <CommandBox key={c.id} cmd={c} />
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-slate-800/80 pt-3">
        {mine && ai.loading ? (
          <div className="flex items-center gap-2 py-3 text-[12px] text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            폴더 구조를 AI 가 분석하는 중…
          </div>
        ) : mine && ai.analysis ? (
          <AnalysisResult a={ai.analysis} item={item} />
        ) : mine && ai.raw ? (
          <div className="text-[12px] text-slate-200">
            <MiniMarkdown text={ai.raw} />
          </div>
        ) : (
          <>
            {mine && ai.error && (
              <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] leading-snug text-rose-200">
                {ai.error}
                <button onClick={() => set({ showSettings: true })} className="ml-1 underline hover:text-white">
                  LLM 설정 열기
                </button>
              </div>
            )}
            <button
              onClick={() => void analyze(item)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-600 to-indigo-600 py-2 text-[12px] font-medium text-white hover:from-sky-500 hover:to-indigo-500"
            >
              <Bot className="h-4 w-4" />
              AI 심층 분석 {verdict.level === "unknown" ? "(권장)" : ""}
            </button>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-600">
              경로, 확장자 분포, 대표 파일명 10개를 설정된 LLM 에 전송합니다.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

const SUGGESTIONS = [
  "개발 환경 안 깨뜨리고 당장 30GB 확보하려면 어디부터 지워야 해?",
  "가장 큰 폴더 5개가 각각 뭔지 설명해 줘",
  "안전하게 지울 수 있는 캐시만 골라서 합계를 알려 줘",
];

function Chat() {
  const chat = useStore((s) => s.chat);
  const loading = useStore((s) => s.chatLoading);
  const sendChat = useStore((s) => s.sendChat);
  const clearChat = useStore((s) => s.clearChat);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.length, loading]);

  const submit = () => {
    if (!text.trim() || loading) return;
    void sendChat(text);
    setText("");
  };

  return (
    <>
      {(chat.length > 0 || loading) && (
        <section className="space-y-2">
          <div className="flex items-center text-[11px] text-slate-500">
            대화
            <button onClick={clearChat} className="ml-auto hover:text-slate-200">
              지우기
            </button>
          </div>
          {chat.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "ml-6 rounded-xl rounded-br-sm bg-sky-600/90 px-3 py-2 text-[12px] text-white"
                  : "mr-2 rounded-xl rounded-bl-sm border border-slate-800/80 bg-slate-900/80 px-3 py-2 text-[12px] text-slate-200"
              }
            >
              {m.role === "user" ? m.content : <MiniMarkdown text={m.content} />}
            </div>
          ))}
          {loading && (
            <div className="mr-2 flex items-center gap-2 rounded-xl border border-slate-800/80 bg-slate-900/80 px-3 py-2 text-[12px] text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" /> 스캔 결과를 바탕으로 답변 작성 중…
            </div>
          )}
          <div ref={endRef} />
        </section>
      )}

      <div className="sticky bottom-0 -mx-3 -mb-3 mt-auto border-t border-slate-800/80 bg-slate-900/95 p-3 backdrop-blur-md">
        {chat.length === 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => void sendChat(s)}
                disabled={loading}
                className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-2.5 py-1.5 text-left text-[11px] leading-snug text-slate-400 hover:border-sky-500/50 hover:text-sky-200"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="스캔 결과에 대해 무엇이든 물어보세요…"
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-slate-800/80 bg-slate-950 px-2.5 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
          <button
            onClick={submit}
            disabled={loading || !text.trim()}
            className="grid h-[44px] w-10 place-items-center rounded-lg bg-sky-600 text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
            title="보내기 (Enter)"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}

export default function AiAdvisorPanel() {
  const selected = useStore((s) => s.selected);
  const provider = useStore((s) => s.settings.provider);
  const model = useStore((s) =>
    s.settings.provider === "ollama"
      ? s.settings.ollamaModel
      : s.settings.provider === "openai"
        ? s.settings.openaiModel
        : s.settings.anthropicModel,
  );
  const set = useStore((s) => s.set);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/80 backdrop-blur-md">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-sky-500 to-indigo-600">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <span className="text-[13px] font-semibold text-slate-100">AI Storage Advisor</span>
        <button
          onClick={() => set({ showSettings: true })}
          className="ml-auto flex max-w-[170px] items-center gap-1 truncate rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-sky-500/50 hover:text-sky-200"
          title="LLM 설정"
        >
          <SettingsIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {PROVIDER_LABEL[provider]} · {model}
          </span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {selected ? (
          <>
            <Inspector item={selected} />
            <AdvisorReport item={selected} />
          </>
        ) : (
          <section className="rounded-xl border border-dashed border-slate-800 p-5 text-center">
            <MousePointerClick className="mx-auto mb-2 h-7 w-7 text-slate-600" />
            <p className="text-[12px] leading-relaxed text-slate-400">
              Treemap 이나 목록에서 폴더/파일을 클릭하면
              <br />
              상세 정보와 삭제 안전도가 여기에 표시됩니다.
            </p>
          </section>
        )}
        <Chat />
      </div>
    </aside>
  );
}
