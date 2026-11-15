//! 파일 조작 및 OS 연동: 탐색기 열기, 휴지통 이동, 화이트리스트 기반 시스템 정리 명령,
//! 안전 캐시(Safe Cache) 스캔/정리.

use serde::Serialize;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::ptr::null;
use windows_sys::Win32::UI::Shell::{SHEmptyRecycleBinW, SHQueryRecycleBinW, SHQUERYRBINFO};

use crate::scanner;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ATTR_REPARSE: u32 = 0x400;
const ATTR_DIRECTORY: u32 = 0x10;

pub fn open_in_explorer(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("경로를 찾을 수 없습니다: {}", path));
    }
    // explorer 는 `/select,"<path>"` 형태의 원시 인자를 요구한다.
    Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 휴지통 이동을 거부해야 하는 OS 핵심 경로인지 검사한다.
pub fn protected_reason(path: &str) -> Option<&'static str> {
    let p = path.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    if p.len() <= 2 {
        return Some("드라이브 루트는 삭제할 수 없습니다.");
    }
    let rest = if p.as_bytes().get(1) == Some(&b':') { &p[2..] } else { p.as_str() };
    if rest == "\\windows" || rest.starts_with("\\windows\\") {
        let safe_sub = ["\\windows\\temp\\", "\\windows\\softwaredistribution\\download\\"];
        if !safe_sub.iter().any(|s| rest.starts_with(s)) {
            return Some("Windows 시스템 폴더는 직접 삭제할 수 없습니다. 전용 정리 명령을 사용하세요.");
        }
    }
    const ROOTS: &[&str] = &[
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\users",
        "\\system volume information",
        "\\$recycle.bin",
        "\\recovery",
        "\\boot",
    ];
    if ROOTS.contains(&rest) {
        return Some("OS 핵심 폴더는 삭제할 수 없습니다.");
    }
    const FILES: &[&str] = &["\\hiberfil.sys", "\\pagefile.sys", "\\swapfile.sys", "\\bootmgr"];
    if FILES.contains(&rest) {
        return Some("시스템 파일은 직접 삭제할 수 없습니다. 전용 명령을 사용하세요.");
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile = profile.trim_end_matches('\\').to_lowercase();
        if p == profile || p == format!("{}\\appdata", profile) {
            return Some("사용자 프로필 폴더는 삭제할 수 없습니다.");
        }
    }
    None
}

pub fn move_to_trash(path: &str) -> Result<(), String> {
    if let Some(reason) = protected_reason(path) {
        return Err(reason.to_string());
    }
    if !Path::new(path).exists() {
        return Err(format!("경로를 찾을 수 없습니다: {}", path));
    }
    trash::delete(path).map_err(|e| format!("휴지통 이동 실패: {}", e))
}

// ---------------------------------------------------------------------------
// 시스템 정리 명령 (화이트리스트)
// ---------------------------------------------------------------------------

enum CmdKind {
    /// 새 콘솔 창에서 실행 (출력을 사용자가 확인)
    Terminal { cmdline: &'static str, admin: bool },
    /// GUI 프로그램/설정 URI 실행
    Launch(&'static str),
    EmptyRecycleBin,
}

fn lookup(id: &str) -> Option<CmdKind> {
    Some(match id {
        "dism_component_cleanup" => CmdKind::Terminal {
            cmdline: "dism /online /cleanup-image /startcomponentcleanup",
            admin: true,
        },
        "hibernate_off" => CmdKind::Terminal { cmdline: "powercfg -h off", admin: true },
        "wsl_shutdown" => CmdKind::Terminal { cmdline: "wsl --shutdown", admin: false },
        "docker_prune" => CmdKind::Terminal { cmdline: "docker system prune", admin: false },
        "disk_cleanup" => CmdKind::Launch("cleanmgr.exe"),
        "open_uninstall" => CmdKind::Launch("ms-settings:appsfeatures"),
        "storage_settings" => CmdKind::Launch("ms-settings:storagesense"),
        "system_protection" => CmdKind::Launch("SystemPropertiesProtection.exe"),
        "empty_recycle_bin" => CmdKind::EmptyRecycleBin,
        _ => return None,
    })
}

/// 사전 정의된 ID 의 정리 명령만 실행한다. 임의 명령 문자열은 받지 않는다.
pub fn run_system_cleanup_cmd(id: &str) -> Result<String, String> {
    match lookup(id).ok_or_else(|| format!("허용되지 않은 명령입니다: {}", id))? {
        CmdKind::Terminal { cmdline, admin } => {
            if admin && !crate::winutil::is_elevated() {
                Command::new("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-WindowStyle",
                        "Hidden",
                        "-Command",
                        &format!("Start-Process cmd.exe -ArgumentList '/k {}' -Verb RunAs", cmdline),
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                Ok(format!("관리자 권한 콘솔에서 실행을 요청했습니다: {}", cmdline))
            } else {
                Command::new("cmd.exe")
                    .raw_arg(format!("/c start \"SpaceSense AI\" cmd.exe /k {}", cmdline))
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                Ok(format!("새 콘솔 창에서 실행했습니다: {}", cmdline))
            }
        }
        CmdKind::Launch(target) => {
            Command::new("cmd.exe")
                .raw_arg(format!("/c start \"\" {}", target))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(format!("실행했습니다: {}", target))
        }
        CmdKind::EmptyRecycleBin => {
            empty_recycle_bin()?;
            Ok("휴지통을 비웠습니다.".into())
        }
    }
}

fn recycle_bin_info() -> (u64, u64) {
    unsafe {
        let mut info: SHQUERYRBINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHQUERYRBINFO>() as u32;
        if SHQueryRecycleBinW(null(), &mut info) == 0 {
            (info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64)
        } else {
            (0, 0)
        }
    }
}

fn empty_recycle_bin() -> Result<(), String> {
    if recycle_bin_info().1 == 0 {
        return Ok(());
    }
    // SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
    let hr = unsafe { SHEmptyRecycleBinW(std::ptr::null_mut(), null(), 0x1 | 0x2 | 0x4) };
    if hr == 0 {
        Ok(())
    } else {
        Err(format!("휴지통 비우기 실패 (HRESULT 0x{:08X})", hr as u32))
    }
}

// ---------------------------------------------------------------------------
// 원클릭 급속 공간 확보 (Safe Cache)
// ---------------------------------------------------------------------------

struct TargetDef {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    /// 환경 변수(%VAR%)를 포함할 수 있는 경로들
    paths: &'static [&'static str],
    default_checked: bool,
    needs_admin: bool,
}

const TARGETS: &[TargetDef] = &[
    TargetDef {
        id: "user_temp",
        label: "사용자 임시 파일",
        description: "프로그램이 남긴 임시 파일입니다. 사용 중인 파일은 자동으로 건너뜁니다.",
        paths: &["%TEMP%"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "win_temp",
        label: "Windows 임시 파일",
        description: "시스템 임시 폴더입니다. 일부 파일은 관리자 권한이 필요합니다.",
        paths: &["%SystemRoot%\\Temp"],
        default_checked: true,
        needs_admin: true,
    },
    TargetDef {
        id: "wu_download",
        label: "Windows 업데이트 다운로드 캐시",
        description: "이미 설치된 업데이트의 설치 파일입니다. 필요 시 다시 다운로드됩니다.",
        paths: &["%SystemRoot%\\SoftwareDistribution\\Download"],
        default_checked: true,
        needs_admin: true,
    },
    TargetDef {
        id: "recycle_bin",
        label: "휴지통",
        description: "모든 드라이브의 휴지통을 비웁니다. 복구할 수 없습니다.",
        paths: &[],
        default_checked: false,
        needs_admin: false,
    },
    TargetDef {
        id: "crash_dumps",
        label: "크래시 덤프 / 오류 보고",
        description: "앱 충돌 시 생성된 덤프와 오류 보고 큐입니다.",
        paths: &["%LOCALAPPDATA%\\CrashDumps", "%LOCALAPPDATA%\\Microsoft\\Windows\\WER"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "shader_cache",
        label: "DirectX 셰이더 캐시",
        description: "그래픽 셰이더 캐시입니다. 게임/앱 실행 시 다시 생성됩니다.",
        paths: &["%LOCALAPPDATA%\\D3DSCache"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "browser_cache",
        label: "브라우저 캐시 (Chrome / Edge)",
        description: "웹 캐시만 삭제합니다. 로그인/북마크/기록은 유지됩니다. 브라우저를 닫고 실행하세요.",
        paths: &[
            "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Cache",
            "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Code Cache",
            "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Cache",
            "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Code Cache",
        ],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "pip_cache",
        label: "pip 캐시",
        description: "Python 패키지 다운로드 캐시입니다. 설치된 패키지에는 영향이 없습니다.",
        paths: &["%LOCALAPPDATA%\\pip\\cache"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "uv_cache",
        label: "uv 캐시",
        description: "uv 패키지 캐시입니다. 다음 설치 시 다시 다운로드됩니다.",
        paths: &["%LOCALAPPDATA%\\uv\\cache"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "npm_cache",
        label: "npm / Yarn 캐시",
        description: "Node 패키지 다운로드 캐시입니다. 프로젝트의 node_modules 는 건드리지 않습니다.",
        paths: &["%LOCALAPPDATA%\\npm-cache\\_cacache", "%LOCALAPPDATA%\\Yarn\\Cache"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "nuget_cache",
        label: "NuGet HTTP 캐시",
        description: "NuGet 메타데이터 캐시입니다. 전역 패키지 폴더는 유지됩니다.",
        paths: &["%LOCALAPPDATA%\\NuGet\\v3-cache"],
        default_checked: true,
        needs_admin: false,
    },
    TargetDef {
        id: "playwright",
        label: "Playwright 브라우저",
        description: "테스트용 브라우저 바이너리입니다. 삭제 후 `npx playwright install` 로 재설치해야 합니다.",
        paths: &["%LOCALAPPDATA%\\ms-playwright"],
        default_checked: false,
        needs_admin: false,
    },
    TargetDef {
        id: "gradle_cache",
        label: "Gradle 캐시",
        description: "Gradle 의존성 캐시입니다. 다음 빌드가 느려지고 다시 다운로드됩니다.",
        paths: &["%USERPROFILE%\\.gradle\\caches"],
        default_checked: false,
        needs_admin: false,
    },
    TargetDef {
        id: "cargo_cache",
        label: "Cargo 레지스트리 캐시",
        description: "Rust crate 다운로드 캐시(.crate)입니다. 필요 시 다시 다운로드됩니다.",
        paths: &["%USERPROFILE%\\.cargo\\registry\\cache"],
        default_checked: false,
        needs_admin: false,
    },
];

fn expand_env(p: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = p;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&std::env::var(&after[..end]).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTarget {
    pub id: String,
    pub label: String,
    pub description: String,
    pub paths: Vec<String>,
    pub size: u64,
    pub files: u64,
    pub default_checked: bool,
    pub needs_admin: bool,
}

fn existing_paths(def: &TargetDef) -> Vec<String> {
    def.paths
        .iter()
        .filter_map(|p| expand_env(p))
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

/// 안전 캐시 대상들의 현재 크기를 병렬로 측정한다.
pub fn scan_safe_caches() -> Vec<CacheTarget> {
    std::thread::scope(|s| {
        let handles: Vec<_> = TARGETS
            .iter()
            .map(|def| {
                s.spawn(move || {
                    let paths = existing_paths(def);
                    let (mut size, mut files) = (0u64, 0u64);
                    if def.id == "recycle_bin" {
                        (size, files) = recycle_bin_info();
                    } else {
                        for p in &paths {
                            let (b, f) = scanner::dir_size(p);
                            size += b;
                            files += f;
                        }
                    }
                    CacheTarget {
                        id: def.id.to_string(),
                        label: def.label.to_string(),
                        description: def.description.to_string(),
                        paths,
                        size,
                        files,
                        default_checked: def.default_checked,
                        needs_admin: def.needs_admin,
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|t| t.files > 0 || t.size > 0)
            .collect()
    })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub freed: u64,
    pub deleted: u64,
    pub failed: u64,
}

/// 폴더 자체는 남기고 내용물만 영구 삭제한다. 사용 중인 파일은 건너뛴다.
fn delete_contents(dir: &Path, res: &mut CleanResult) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        res.failed += 1;
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            res.failed += 1;
            continue;
        };
        let attrs = meta.file_attributes();
        if attrs & ATTR_REPARSE != 0 {
            // 링크/정션은 대상이 아닌 링크 자체만 제거한다.
            let ok = if attrs & ATTR_DIRECTORY != 0 {
                std::fs::remove_dir(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if ok { res.deleted += 1 } else { res.failed += 1 }
        } else if attrs & ATTR_DIRECTORY != 0 {
            delete_contents(&path, res);
            let _ = std::fs::remove_dir(&path);
        } else {
            let len = meta.len();
            let mut ok = std::fs::remove_file(&path).is_ok();
            if !ok && meta.permissions().readonly() {
                let mut perm = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(false);
                ok = std::fs::set_permissions(&path, perm).is_ok() && std::fs::remove_file(&path).is_ok();
            }
            if ok {
                res.deleted += 1;
                res.freed += len;
            } else {
                res.failed += 1;
            }
        }
    }
}

/// 선택된 대상 ID 만 정리한다. 경로는 프론트엔드가 아니라 내장 목록에서만 가져온다.
pub fn clean_safe_caches(ids: &[String]) -> CleanResult {
    let mut res = CleanResult::default();
    for def in TARGETS.iter().filter(|d| ids.iter().any(|i| i == d.id)) {
        if def.id == "recycle_bin" {
            let (size, items) = recycle_bin_info();
            match empty_recycle_bin() {
                Ok(()) => {
                    res.freed += size;
                    res.deleted += items;
                }
                Err(_) => res.failed += 1,
            }
            continue;
        }
        for p in existing_paths(def) {
            delete_contents(Path::new(&p), &mut res);
        }
    }
    res
}
