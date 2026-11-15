/**
 * Windows 경로 안전도 룰 엔진 + 파일 카테고리 분류 + LLM 프롬프트 빌더.
 *
 * 1차: 내장 경로 패턴으로 즉시 판정 (네트워크 호출 없음)
 * 2차: 룰에 걸리지 않는 항목은 폴더 구조 메타데이터를 JSON 으로 직렬화해 LLM 에 질의
 */
import type { NodeDetails, ScanSummary, Selected } from "../types";
import { formatBytes, formatDate } from "../lib/format";

// ---------------------------------------------------------------------------
// 정리 명령 카탈로그 (백엔드 cleaner::lookup 의 화이트리스트와 ID 가 일치해야 한다)
// ---------------------------------------------------------------------------

export interface CleanupCommand {
  id: string;
  label: string;
  /** 사용자에게 보여 주고 복사할 수 있는 명령 문자열 */
  command: string;
  admin: boolean;
  /** 앱에서 [실행] 버튼으로 바로 실행 가능한지 */
  runnable: boolean;
}

export const COMMANDS: Record<string, CleanupCommand> = {
  dism_component_cleanup: {
    id: "dism_component_cleanup",
    label: "구성 요소 저장소 정리 (DISM)",
    command: "dism /online /cleanup-image /startcomponentcleanup",
    admin: true,
    runnable: true,
  },
  hibernate_off: {
    id: "hibernate_off",
    label: "최대 절전 모드 끄기",
    command: "powercfg -h off",
    admin: true,
    runnable: true,
  },
  wsl_shutdown: {
    id: "wsl_shutdown",
    label: "WSL 종료",
    command: "wsl --shutdown",
    admin: false,
    runnable: true,
  },
  docker_prune: {
    id: "docker_prune",
    label: "Docker 미사용 리소스 정리",
    command: "docker system prune",
    admin: false,
    runnable: true,
  },
  disk_cleanup: {
    id: "disk_cleanup",
    label: "디스크 정리 열기",
    command: "cleanmgr.exe",
    admin: false,
    runnable: true,
  },
  open_uninstall: {
    id: "open_uninstall",
    label: "설치된 앱 (앱 제거) 열기",
    command: "ms-settings:appsfeatures",
    admin: false,
    runnable: true,
  },
  storage_settings: {
    id: "storage_settings",
    label: "저장소 설정 열기",
    command: "ms-settings:storagesense",
    admin: false,
    runnable: true,
  },
  system_protection: {
    id: "system_protection",
    label: "시스템 보호(복원 지점) 설정 열기",
    command: "SystemPropertiesProtection.exe",
    admin: false,
    runnable: true,
  },
  empty_recycle_bin: {
    id: "empty_recycle_bin",
    label: "휴지통 비우기",
    command: "Clear-RecycleBin -Force",
    admin: false,
    runnable: true,
  },
  optimize_vhd: {
    id: "optimize_vhd",
    label: "가상 디스크 압축 (복사 후 관리자 PowerShell 에서 실행)",
    command: 'wsl --shutdown; Optimize-VHD -Path "<vhdx 경로>" -Mode Full',
    admin: true,
    runnable: false,
  },
  diskpart_compact: {
    id: "diskpart_compact",
    label: "diskpart 로 가상 디스크 압축 (Hyper-V 모듈이 없을 때)",
    command: 'diskpart → select vdisk file="<vhdx 경로>" → compact vdisk',
    admin: true,
    runnable: false,
  },
  pagefile_settings: {
    id: "pagefile_settings",
    label: "가상 메모리 설정 열기 (복사 후 실행)",
    command: "SystemPropertiesPerformance.exe",
    admin: false,
    runnable: false,
  },
};

// ---------------------------------------------------------------------------
// 안전도 룰
// ---------------------------------------------------------------------------

export type SafetyLevel = "critical" | "action" | "caution" | "safe" | "unknown";

export interface SafetyVerdict {
  level: SafetyLevel;
  ruleId: string;
  title: string;
  message: string;
  commands: CleanupCommand[];
}

interface Rule {
  id: string;
  level: SafetyLevel;
  /** 소문자화·백슬래시 정규화된 전체 경로에 대한 패턴 */
  re: RegExp;
  title: string;
  message: string;
  commands?: string[];
  /** vhdx 처럼 명령에 실제 경로를 채워 넣어야 하는 경우 */
  fillPath?: boolean;
}

const D = "^[a-z]:"; // 드라이브 접두사
const END = "(\\\\|$)"; // 해당 폴더 자체 또는 그 하위
const USER = `${D}\\\\users\\\\[^\\\\]+`;
const ANY = "(^|\\\\)"; // 경로 어디에서든 폴더명으로 등장

/** 먼저 선언된 룰이 우선한다. 구체적인 룰을 위에, 포괄적인 룰을 아래에 둔다. */
const RULES: Rule[] = [
  // ----- 전용 도구로 정리 (ACTION REQUIRED) -----
  {
    id: "hiberfil",
    level: "action",
    re: new RegExp(`${D}\\\\hiberfil\\.sys$`),
    title: "최대 절전 모드 파일",
    message:
      "최대 절전 모드 파일입니다. 직접 삭제할 수 없으며 관리자 터미널에서 `powercfg -h off` 실행 시 즉시 확보됩니다. (빠른 시작 기능도 함께 꺼집니다)",
    commands: ["hibernate_off"],
  },
  {
    id: "pagefile",
    level: "action",
    re: new RegExp(`${D}\\\\(pagefile|swapfile)\\.sys$`),
    title: "가상 메모리(페이지 파일)",
    message:
      "Windows 가상 메모리 파일입니다. 직접 삭제할 수 없습니다. 크기를 줄이려면 [시스템 속성 > 고급 > 성능 > 가상 메모리]에서 조정하세요. RAM 이 부족한 PC 에서는 줄이지 않는 것이 좋습니다.",
    commands: ["pagefile_settings"],
  },
  {
    id: "winsxs",
    level: "action",
    re: new RegExp(`${D}\\\\windows\\\\winsxs${END}`),
    title: "Windows 구성 요소 저장소 (WinSxS)",
    message:
      "직접 삭제 시 OS가 부팅되지 않습니다. 대신 `dism /online /cleanup-image /startcomponentcleanup` 실행 버튼을 누르세요. 대부분 하드링크라 실제 점유는 표시보다 작습니다.",
    commands: ["dism_component_cleanup"],
  },
  {
    id: "vhdx",
    level: "action",
    re: /\.(vhdx|vhd)$/,
    title: "가상 디스크 파일 (WSL2 / Docker / Hyper-V)",
    message:
      "가상 디스크 파일입니다. 삭제하면 그 안의 리눅스 배포판/컨테이너 데이터가 모두 사라집니다. WSL 종료 후 `Optimize-VHD` 또는 `diskpart compact vdisk`로 실제 미사용 공간을 압축 회수할 수 있습니다.",
    commands: ["wsl_shutdown", "optimize_vhd", "diskpart_compact", "docker_prune"],
    fillPath: true,
  },
  {
    id: "windows_old",
    level: "action",
    re: new RegExp(`${D}\\\\(windows\\.old|\\$windows\\.~bt|\\$windows\\.~ws)${END}`),
    title: "이전 Windows 설치",
    message:
      "이전 버전 Windows 백업입니다. 롤백 계획이 없다면 [디스크 정리 > 시스템 파일 정리 > 이전 Windows 설치]로 안전하게 제거하세요. 탐색기에서 직접 지우면 권한 문제로 일부가 남습니다.",
    commands: ["disk_cleanup", "storage_settings"],
  },
  {
    id: "sysvol",
    level: "action",
    re: new RegExp(`${D}\\\\system volume information${END}`),
    title: "시스템 복원 지점 / 볼륨 섀도",
    message:
      "시스템 복원 지점과 섀도 복사본이 저장됩니다. 직접 삭제할 수 없으며 [시스템 보호] 설정에서 사용 공간 한도를 줄이거나 오래된 복원 지점을 삭제하세요.",
    commands: ["system_protection"],
  },
  {
    id: "recycle_bin",
    level: "safe",
    re: new RegExp(`${D}\\\\\\$recycle\\.bin${END}`),
    title: "휴지통",
    message: "삭제 대기 중인 파일입니다. 복구할 파일이 없다면 휴지통 비우기로 즉시 공간을 확보할 수 있습니다.",
    commands: ["empty_recycle_bin"],
  },
  {
    id: "installer",
    level: "critical",
    re: new RegExp(`${D}\\\\windows\\\\installer${END}`),
    title: "Windows Installer 캐시",
    message:
      "설치된 프로그램의 복구/제거에 필요한 MSI·패치 파일입니다. 삭제하면 프로그램 업데이트와 제거가 실패합니다.",
  },
  {
    id: "docker_data",
    level: "action",
    re: new RegExp(`(${USER}\\\\appdata\\\\local\\\\docker|${D}\\\\programdata\\\\docker(desktop)?)${END}`),
    title: "Docker 데이터",
    message:
      "Docker 이미지·컨테이너·볼륨 저장소입니다. 직접 삭제하지 말고 `docker system prune` 으로 미사용 리소스를 정리하세요.",
    commands: ["docker_prune"],
  },

  // ----- 안전한 캐시/임시 파일 (SAFE TO CLEAN) -----
  {
    id: "win_temp",
    level: "safe",
    re: new RegExp(`${D}\\\\windows\\\\temp${END}`),
    title: "Windows 임시 폴더",
    message: "시스템 임시 파일입니다. 사용 중인 파일을 제외하고 안전하게 삭제할 수 있습니다.",
  },
  {
    id: "wu_download",
    level: "safe",
    re: new RegExp(`${D}\\\\windows\\\\softwaredistribution\\\\download${END}`),
    title: "Windows 업데이트 다운로드 캐시",
    message: "설치가 끝난 업데이트의 다운로드 파일입니다. 삭제해도 필요 시 다시 다운로드됩니다.",
  },
  {
    id: "user_temp",
    level: "safe",
    re: new RegExp(`${USER}\\\\appdata\\\\local\\\\temp${END}`),
    title: "사용자 임시 폴더",
    message: "프로그램이 남긴 임시 파일입니다. 실행 중인 프로그램을 닫은 뒤 삭제하면 안전합니다.",
  },
  {
    id: "dev_pkg_cache",
    level: "safe",
    re: new RegExp(
      `${USER}\\\\appdata\\\\local\\\\(uv\\\\cache|pip\\\\cache|npm-cache|yarn\\\\cache|ms-playwright|nuget\\\\v3-cache|pnpm-cache|go-build)${END}`,
    ),
    title: "개발 도구 패키지 캐시",
    message:
      "패키지 관리자 다운로드 캐시입니다. 삭제해도 설치된 프로젝트는 영향이 없고, 다음 설치 때 다시 다운로드됩니다.",
  },
  {
    id: "crash_dumps",
    level: "safe",
    re: new RegExp(
      `(${USER}\\\\appdata\\\\local\\\\(crashdumps|d3dscache|microsoft\\\\windows\\\\wer)|${D}\\\\programdata\\\\microsoft\\\\windows\\\\wer)${END}`,
    ),
    title: "크래시 덤프 / 셰이더 캐시",
    message: "오류 보고용 덤프와 자동 재생성되는 캐시입니다. 안전하게 삭제할 수 있습니다.",
  },
  {
    id: "browser_cache",
    level: "safe",
    re: new RegExp(`\\\\user data\\\\[^\\\\]+\\\\(cache|code cache|gpucache|service worker\\\\cachestorage)${END}`),
    title: "브라우저 캐시",
    message: "웹 캐시입니다. 삭제해도 로그인·북마크·기록은 유지됩니다. 브라우저를 닫고 삭제하세요.",
  },
  {
    id: "node_modules",
    level: "safe",
    re: new RegExp(`${ANY}node_modules${END}`),
    title: "node_modules (재설치 가능)",
    message:
      "프로젝트 의존성 폴더입니다. 삭제해도 `npm install` 로 복원됩니다. 현재 작업 중이 아닌 프로젝트라면 안전하게 지울 수 있습니다.",
  },
  {
    id: "venv",
    level: "safe",
    re: new RegExp(`${ANY}(\\.venv|venv|__pycache__|\\.pytest_cache|\\.mypy_cache|\\.ruff_cache|\\.tox)${END}`),
    title: "Python 가상환경 / 캐시 (재생성 가능)",
    message:
      "가상환경과 바이트코드 캐시입니다. 삭제해도 `uv sync` / `pip install -r requirements.txt` 로 다시 만들 수 있습니다.",
  },
  {
    id: "build_cache",
    level: "safe",
    re: new RegExp(`${ANY}(\\.gradle\\\\caches|\\.cargo\\\\registry\\\\cache|\\.next\\\\cache|\\.turbo|\\.parcel-cache)${END}`),
    title: "빌드 도구 캐시",
    message: "빌드/의존성 캐시입니다. 삭제하면 다음 빌드가 느려지지만 자동으로 다시 만들어집니다.",
  },
  {
    id: "rust_target",
    level: "safe",
    re: new RegExp(`(\\\\src-tauri\\\\target|${ANY}target\\\\(debug|release))${END}`),
    title: "Rust 빌드 산출물 (target)",
    message:
      "Cargo 빌드 결과물과 중간 파일입니다. 삭제해도 `cargo build` 로 다시 만들어집니다(다음 빌드는 처음부터 컴파일). 배포할 exe 가 들어 있다면 먼저 옮겨 두세요.",
  },

  // ----- 절대 삭제 금지 (CRITICAL) -----
  {
    id: "system32",
    level: "critical",
    re: new RegExp(`${D}\\\\windows\\\\(system32|syswow64|systemapps|boot|fonts|servicing|assembly)${END}`),
    title: "Windows 핵심 시스템 폴더",
    message: "OS 실행에 필요한 핵심 파일입니다. 어떤 파일도 직접 삭제하지 마세요. 부팅 불가 상태가 될 수 있습니다.",
  },
  {
    id: "windows",
    level: "critical",
    re: new RegExp(`${D}\\\\windows${END}`),
    title: "Windows 폴더",
    message:
      "운영체제 파일입니다. 직접 삭제하지 말고 [디스크 정리] 또는 [저장소 설정]의 시스템 파일 정리를 이용하세요.",
    commands: ["disk_cleanup", "dism_component_cleanup"],
  },
  {
    id: "program_files",
    level: "critical",
    re: new RegExp(`${D}\\\\program files( \\(x86\\))?${END}`),
    title: "설치된 프로그램",
    message:
      "설치된 프로그램 폴더입니다. 폴더를 직접 지우면 레지스트리와 서비스가 남아 오류가 납니다. 반드시 [설치된 앱]에서 제거하세요.",
    commands: ["open_uninstall"],
  },
  {
    id: "boot_files",
    level: "critical",
    re: new RegExp(`${D}\\\\(bootmgr|bootnxt|boot|recovery|efi|\\$sysreset|dumpstack\\.log(\\.tmp)?)${END}`),
    title: "부팅 / 복구 파일",
    message: "부팅과 시스템 복구에 필요한 파일입니다. 삭제하면 부팅이 불가능해질 수 있습니다.",
  },
  {
    id: "programdata_ms",
    level: "critical",
    re: new RegExp(`${D}\\\\programdata\\\\(microsoft|package cache|packages)${END}`),
    title: "시스템 공용 데이터",
    message: "Windows 와 설치 관리자가 사용하는 공용 데이터입니다. 직접 삭제하면 업데이트·복구·제거가 실패할 수 있습니다.",
  },
  {
    id: "roaming",
    level: "critical",
    re: new RegExp(`${USER}\\\\appdata\\\\roaming$`),
    title: "앱 설정 저장소 (AppData\\Roaming)",
    message: "거의 모든 프로그램의 사용자 설정·프로필이 저장됩니다. 폴더 전체를 지우면 모든 앱 설정이 초기화됩니다.",
  },
  {
    id: "user_root",
    level: "critical",
    re: new RegExp(`(${D}\\\\users|${USER}|${USER}\\\\appdata|${USER}\\\\appdata\\\\(local|locallow))$`),
    title: "사용자 프로필 루트",
    message: "사용자 계정의 최상위 폴더입니다. 폴더 자체가 아니라 내부의 개별 항목을 살펴보세요.",
  },
  {
    id: "registry_hive",
    level: "critical",
    re: new RegExp(`${USER}\\\\ntuser\\.(dat|ini|pol)`),
    title: "사용자 레지스트리 하이브",
    message: "사용자 계정의 레지스트리 파일입니다. 삭제하면 계정 프로필이 손상됩니다.",
  },

  // ----- 확인 필요 (CAUTION) -----
  {
    id: "roaming_app",
    level: "caution",
    re: new RegExp(`${USER}\\\\appdata\\\\roaming\\\\`),
    title: "앱 사용자 설정 (Roaming)",
    message:
      "특정 프로그램의 설정·프로필 데이터입니다. 이미 제거한 프로그램의 것이라면 지워도 되지만, 사용 중인 앱이라면 설정과 로그인 정보가 사라집니다. AI 심층 분석으로 정체를 확인하세요.",
    commands: ["open_uninstall"],
  },
  {
    id: "local_app",
    level: "caution",
    re: new RegExp(`${USER}\\\\appdata\\\\(local|locallow)\\\\`),
    title: "앱 로컬 데이터",
    message:
      "프로그램의 로컬 데이터·캐시입니다. 캐시라면 안전하지만 데이터베이스나 설정일 수도 있습니다. AI 심층 분석으로 확인 후 삭제하세요.",
  },
  {
    id: "programdata",
    level: "caution",
    re: new RegExp(`${D}\\\\programdata\\\\`),
    title: "프로그램 공용 데이터",
    message:
      "프로그램이 모든 사용자 공용으로 저장한 데이터입니다. 제거된 프로그램의 고아 폴더일 수 있으니 AI 심층 분석으로 확인하세요.",
    commands: ["open_uninstall"],
  },
  {
    id: "downloads",
    level: "caution",
    re: new RegExp(`${USER}\\\\downloads${END}`),
    title: "다운로드 폴더",
    message: "직접 내려받은 파일입니다. 설치가 끝난 설치 파일·압축 파일은 지워도 되지만, 내용은 직접 확인하세요.",
  },
  {
    id: "user_data",
    level: "caution",
    re: new RegExp(`${USER}\\\\(documents|desktop|pictures|videos|music|onedrive[^\\\\]*|source|projects)${END}`),
    title: "개인 데이터",
    message: "직접 만든 문서·사진·프로젝트입니다. 시스템에는 영향이 없지만 복구할 수 없는 개인 자료일 수 있습니다.",
  },
];

const UNKNOWN: SafetyVerdict = {
  level: "unknown",
  ruleId: "unknown",
  title: "분류되지 않은 항목",
  message: "내장 규칙에 없는 경로입니다. AI 심층 분석으로 정체와 삭제 안전도를 확인해 보세요.",
  commands: [],
};

const cache = new Map<string, SafetyVerdict>();

export function normalizePath(path: string): string {
  let p = path.replace(/\//g, "\\").toLowerCase();
  while (p.length > 3 && p.endsWith("\\")) p = p.slice(0, -1);
  return p;
}

/** 경로의 삭제 안전도를 내장 룰로 즉시 판정한다. */
export function classifyPath(path: string): SafetyVerdict {
  const key = normalizePath(path);
  const hit = cache.get(key);
  if (hit) return hit;
  let verdict = UNKNOWN;
  for (const r of RULES) {
    if (r.re.test(key)) {
      const commands = (r.commands ?? []).map((id) => {
        const c = COMMANDS[id];
        return r.fillPath ? { ...c, command: c.command.replace("<vhdx 경로>", path) } : c;
      });
      verdict = { level: r.level, ruleId: r.id, title: r.title, message: r.message, commands };
      break;
    }
  }
  if (cache.size > 200_000) cache.clear();
  cache.set(key, verdict);
  return verdict;
}

export const LEVEL_META: Record<
  SafetyLevel,
  { label: string; short: string; color: string; badge: string; dot: string }
> = {
  critical: {
    label: "절대 삭제 금지",
    short: "금지",
    color: "#f43f5e",
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    dot: "bg-rose-500",
  },
  action: {
    label: "전용 도구로 정리",
    short: "전용 도구",
    color: "#eab308",
    badge: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40",
    dot: "bg-yellow-400",
  },
  caution: {
    label: "확인 필요",
    short: "주의",
    color: "#eab308",
    badge: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40",
    dot: "bg-yellow-400",
  },
  safe: {
    label: "삭제 안전",
    short: "안전",
    color: "#22c55e",
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    dot: "bg-emerald-500",
  },
  unknown: {
    label: "분류되지 않음",
    short: "미분류",
    color: "#475569",
    badge: "bg-slate-500/15 text-slate-300 border-slate-500/40",
    dot: "bg-slate-500",
  },
};

/** 휴지통 이동을 UI 단계에서 막아야 하는지 */
export function isTrashBlocked(v: SafetyVerdict): boolean {
  return v.level === "critical" || (v.level === "action" && v.ruleId !== "vhdx");
}

// ---------------------------------------------------------------------------
// 파일 카테고리 (Treemap 색상)
// ---------------------------------------------------------------------------

export type Category = "system" | "vdisk" | "dev" | "media" | "doc" | "archive" | "folder" | "other";

export const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  system: { label: "시스템", color: "#ef4444" },
  vdisk: { label: "가상디스크·컨테이너·모델", color: "#a855f7" },
  dev: { label: "개발·패키지 캐시", color: "#f59e0b" },
  media: { label: "미디어", color: "#3b82f6" },
  doc: { label: "문서·앱", color: "#10b981" },
  archive: { label: "압축·설치 파일", color: "#14b8a6" },
  folder: { label: "폴더(미확장)", color: "#6366f1" },
  other: { label: "기타", color: "#64748b" },
};

const EXT: Record<string, Category> = {};
const reg = (cat: Category, exts: string) => exts.split(" ").forEach((e) => (EXT[e] = cat));
reg("system", "sys dll mui msp msu cat etl drv ocx cpl manifest dmp regtrans-ms blf evtx efi mum");
reg("vdisk", "vhdx vhd vmdk vdi qcow2 img wim esd gguf safetensors ckpt onnx pt pth bin");
reg("dev", "pyc pyd o obj pdb lib a rlib rmeta class jar whl nupkg crate map tsbuildinfo node wasm");
reg("media", "mp4 mkv avi mov wmv webm flv m4v mp3 flac wav aac ogg m4a jpg jpeg png gif bmp webp heic tif tiff psd raw cr2 nef svg ico");
reg("doc", "pdf doc docx xls xlsx ppt pptx hwp hwpx txt md rtf csv json xml yaml yml html htm exe lnk epub one pst ost db sqlite");
reg("archive", "zip 7z rar tar gz bz2 xz zst cab iso msi msix appx pak");

const RE_SYSTEM_PATH = new RegExp(
  `${D}\\\\(windows|\\$recycle\\.bin|system volume information|recovery|programdata\\\\microsoft)${END}|${D}\\\\(hiberfil|pagefile|swapfile)\\.sys$`,
);
const RE_DEV_PATH = new RegExp(
  `${ANY}(node_modules|\\.venv|venv|__pycache__|\\.git|\\.gradle|\\.m2|\\.nuget|\\.cargo|\\.rustup|\\.cache|npm-cache|ms-playwright|site-packages|\\.pnpm-store|\\.conda|pkgs|src-tauri\\\\target|target\\\\(debug|release))${END}|\\\\appdata\\\\local\\\\(uv|pip|yarn|pnpm|go-build)${END}`,
);
const RE_VDISK_PATH = new RegExp(`${ANY}(docker|wsl|hyper-v|virtualbox vms|\\.ollama|huggingface)${END}`);
const RE_APP_PATH = new RegExp(`${D}\\\\program files( \\(x86\\))?${END}`);

const catCache = new Map<string, Category>();

export function categoryOf(path: string, name: string, isDir: boolean): Category {
  const key = (isDir ? "d|" : "f|") + path;
  const hit = catCache.get(key);
  if (hit) return hit;
  const p = normalizePath(path);
  let cat: Category;
  if (RE_SYSTEM_PATH.test(p)) cat = "system";
  else if (RE_DEV_PATH.test(p)) cat = "dev";
  else if (isDir) {
    cat = RE_VDISK_PATH.test(p) ? "vdisk" : RE_APP_PATH.test(p) ? "doc" : "folder";
  } else {
    const i = name.lastIndexOf(".");
    const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
    cat = EXT[ext] ?? (RE_VDISK_PATH.test(p) ? "vdisk" : RE_APP_PATH.test(p) ? "doc" : "other");
  }
  if (catCache.size > 200_000) catCache.clear();
  catCache.set(key, cat);
  return cat;
}

// ---------------------------------------------------------------------------
// LLM 프롬프트 빌더 / 응답 파서
// ---------------------------------------------------------------------------

export type AiSafety = "safe" | "caution" | "danger";
export type AiActionType = "trash" | "command" | "uninstall" | "none";

export interface AiAnalysis {
  identity: string;
  safety: AiSafety;
  sideEffects: string;
  recommendation: string;
  action: {
    type: AiActionType;
    commandId: string | null;
    command: string | null;
    label: string;
  };
}

const RUNNABLE_IDS = Object.values(COMMANDS)
  .filter((c) => c.runnable)
  .map((c) => `"${c.id}" (${c.command})`)
  .join(", ");

export const ANALYSIS_SYSTEM_PROMPT = `당신은 Windows 스토리지 전문가 "AI Storage Advisor"입니다.
사용자가 디스크 분석 도구에서 선택한 폴더/파일의 메타데이터(JSON)를 받아, 그것이 무엇이고 삭제해도 안전한지 판정합니다.

판정 원칙:
- 경로, 하위 확장자 분포, 파일명 샘플, 수정일자를 근거로 어떤 프로그램이 만들었고 어떤 역할인지 추론합니다.
- 확신이 없으면 추측임을 밝히고 안전도를 한 단계 보수적으로 매깁니다.
- OS 구성 요소, 드라이버, 설치된 프로그램 본체는 "danger" 입니다.
- 재생성/재다운로드 가능한 캐시·임시·로그·덤프는 "safe" 입니다.
- 사용자 설정·로그인 세션·데이터베이스·개인 자료가 섞여 있으면 "caution" 입니다.
- 제거된 프로그램이 남긴 고아 폴더로 보이면 그렇게 명시합니다.

반드시 아래 JSON 객체 하나만 출력하세요. 코드 블록이나 설명 문장을 덧붙이지 마세요.
{
  "identity": "이 항목을 생성한 프로그램과 역할 (2~3문장, 한국어)",
  "safety": "safe" | "caution" | "danger",
  "sideEffects": "삭제 시 발생하는 부작용 (한국어, 구체적으로)",
  "recommendation": "사용자에게 권하는 조치 (1~2문장, 한국어)",
  "action": {
    "type": "trash" | "command" | "uninstall" | "none",
    "commandId": 아래 허용 ID 중 하나 또는 null,
    "command": 허용 ID 에 없는 정리 명령이 필요하면 그 명령 문자열, 아니면 null,
    "label": "버튼에 표시할 짧은 문구"
  }
}

action.type 선택 기준:
- "trash": 휴지통으로 옮겨도 되는 경우 (safe, 또는 사용자가 감수할 만한 caution)
- "command": 전용 정리 명령이 더 적절한 경우. 가능하면 commandId 를 사용
- "uninstall": 설치된 프로그램이므로 앱 제거로 지워야 하는 경우
- "none": 건드리지 말아야 하는 경우

허용 commandId: ${RUNNABLE_IDS}`;

/** 선택 노드 메타데이터를 LLM 에 보낼 JSON 문자열로 직렬화한다. */
export function buildAnalysisPrompt(d: NodeDetails, verdict: SafetyVerdict): string {
  const payload = {
    path: d.path,
    type: d.isDir ? "folder" : "file",
    sizeOnDisk: formatBytes(d.alloc),
    logicalSize: formatBytes(d.size),
    fileCount: d.files,
    folderCount: d.dirs,
    lastModified: formatDate(d.mtime),
    lastAccessed: formatDate(d.atime),
    shareOfScan: `${d.percentOfScan.toFixed(2)}%`,
    extensionDistribution: d.extStats.map((e) => ({
      ext: e.ext,
      files: e.count,
      size: formatBytes(e.size),
    })),
    largestFiles: d.samples.map((s) => ({
      name: s.name,
      size: formatBytes(s.size),
      modified: formatDate(s.mtime),
    })),
    topChildren: d.topChildren.map((c) => ({
      name: c.name,
      type: c.isDir ? "folder" : "file",
      size: formatBytes(c.size),
    })),
    statsTruncated: d.truncated,
    localRuleVerdict:
      verdict.level === "unknown" ? null : { level: verdict.level, title: verdict.title },
  };
  return `다음 항목을 분석해 주세요.\n\n${JSON.stringify(payload, null, 2)}`;
}

/** LLM 응답에서 JSON 을 추출해 검증한다. 형식이 맞지 않으면 null. */
export function parseAnalysis(text: string): AiAnalysis | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const safety: AiSafety = ["safe", "caution", "danger"].includes(o.safety) ? o.safety : "caution";
    const a = o.action ?? {};
    let type: AiActionType = ["trash", "command", "uninstall", "none"].includes(a.type)
      ? a.type
      : "none";
    const commandId =
      typeof a.commandId === "string" && COMMANDS[a.commandId]?.runnable ? a.commandId : null;
    const command = typeof a.command === "string" && a.command.trim() ? a.command.trim() : null;
    if (type === "command" && !commandId && !command) type = "none";
    // 위험 판정인데 휴지통 이동을 권하는 모순된 응답은 버튼을 내지 않는다.
    if (safety === "danger" && type === "trash") type = "none";
    if (typeof o.identity !== "string") return null;
    return {
      identity: o.identity,
      safety,
      sideEffects: String(o.sideEffects ?? ""),
      recommendation: String(o.recommendation ?? ""),
      action: { type, commandId, command, label: String(a.label ?? "") },
    };
  } catch {
    return null;
  }
}

/** 자유 질문 채팅용 시스템 프롬프트: 현재 스캔 요약과 룰 판정을 컨텍스트로 포함한다. */
export function buildChatSystemPrompt(summary: ScanSummary | null, selected: Selected | null): string {
  let ctx = "아직 스캔 결과가 없습니다. 사용자에게 먼저 드라이브를 스캔하도록 안내하세요.";
  if (summary) {
    const tag = (path: string) => {
      const v = classifyPath(path);
      return v.level === "unknown" ? undefined : v.level;
    };
    const seen: string[] = [];
    const candidates = summary.cacheCandidates
      .filter((c) => classifyPath(c.path).level === "safe")
      .filter((c) => {
        // 이미 포함된 상위 폴더의 하위 항목은 중복이므로 제외
        const p = normalizePath(c.path);
        if (seen.some((s) => p.startsWith(s + "\\"))) return false;
        seen.push(p);
        return true;
      })
      .slice(0, 30)
      .map((c) => ({ path: c.path, size: formatBytes(c.size) }));
    ctx = JSON.stringify(
      {
        scanRoot: summary.rootPath,
        scanComplete: summary.done,
        totalOnDisk: formatBytes(summary.totalAlloc),
        files: summary.files,
        folders: summary.dirs,
        unreadableFolders: summary.errors,
        topFolders: summary.topDirs.map((d) => ({
          path: d.path,
          size: formatBytes(d.size),
          safety: tag(d.path),
          children: d.children.map((c) => ({
            name: c.name,
            size: formatBytes(c.size),
            safety: tag(`${d.path}\\${c.name}`),
          })),
        })),
        largestFiles: summary.topFiles.map((f) => ({
          path: f.path,
          size: formatBytes(f.size),
          safety: tag(f.path),
        })),
        safeCleanupCandidates: candidates,
        currentlySelected: selected
          ? { path: selected.path, size: formatBytes(selected.alloc), safety: tag(selected.path) }
          : null,
      },
      null,
      1,
    );
  }
  return `당신은 Windows 디스크 공간 분석 앱 "SpaceSense AI"에 탑재된 "AI Storage Advisor"입니다.
아래 JSON 은 사용자의 실제 디스크 스캔 요약입니다. 이 데이터에 근거해서만 답하고, 데이터에 없는 경로나 용량을 지어내지 마세요.

safety 필드 의미: "safe"=삭제 안전(재생성 가능한 캐시/임시), "caution"=확인 필요, "action"=전용 명령으로만 정리, "critical"=절대 삭제 금지.

답변 규칙:
- 한국어로, 간결한 마크다운으로 답합니다.
- 공간 확보 질문에는 위험이 낮고 확보량이 큰 순서의 우선순위 체크리스트(- [ ] 항목, 예상 확보량, 방법)를 제시합니다.
- 각 항목에 실제 경로와 예상 확보 용량을 명시하고, 합계가 목표에 도달하는지 계산해 보여 줍니다.
- critical 항목의 직접 삭제는 절대 권하지 않습니다. action 항목은 해당 전용 명령(예: \`powercfg -h off\`, \`dism /online /cleanup-image /startcomponentcleanup\`, \`wsl --shutdown\` 후 \`Optimize-VHD\`)을 안내합니다.
- 개발 환경을 깨뜨릴 수 있는 항목(전역 툴체인, 사용 중인 프로젝트의 의존성)은 구분해서 경고합니다.
- 스캔이 완료되지 않았다면(scanComplete=false) 수치가 잠정치임을 알립니다.

[디스크 스캔 요약]
${ctx}`;
}
