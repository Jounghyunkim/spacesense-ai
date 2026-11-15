#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cleaner;
mod llm;
mod scanner;
mod settings;
mod winutil;

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use scanner::ScanState;

#[derive(Clone, Copy)]
struct ViewReq {
    node: u32,
    depth: u32,
    by_alloc: bool,
}

struct AppState {
    scan: Mutex<Option<Arc<ScanState>>>,
    view: Mutex<ViewReq>,
    seq: AtomicU64,
}

impl AppState {
    fn current(&self) -> Result<Arc<ScanState>, String> {
        self.scan.lock().clone().ok_or_else(|| "먼저 스캔을 실행하세요.".to_string())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress<'a> {
    scan_id: u64,
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    elapsed_ms: u64,
    done: bool,
    cancelled: bool,
    current: String,
    view: &'a scanner::ViewSnapshot,
}

#[tauri::command]
fn list_drives() -> Vec<winutil::DriveInfo> {
    winutil::list_drives()
}

#[tauri::command(async)]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("스캔할 폴더 선택")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>, path: String) -> Result<u64, String> {
    let root = winutil::normalize_root(&path);
    if !std::path::Path::new(&root).is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: {}", root));
    }
    if let Some(old) = state.scan.lock().as_ref() {
        old.cancel.store(true, Ordering::SeqCst);
    }
    let id = state.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let st = Arc::new(ScanState::new(id, root));
    *state.scan.lock() = Some(st.clone());
    state.view.lock().node = 0;

    let worker_st = st.clone();
    std::thread::spawn(move || scanner::run(&worker_st));

    // 200ms 주기로 현재 뷰의 트리 스냅샷을 스트리밍한다.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let done = st.done.load(Ordering::SeqCst);
        let req = *app.state::<AppState>().view.lock();
        let view = scanner::snapshot(&st, req.node, req.depth, req.by_alloc);
        let payload = ScanProgress {
            scan_id: st.id,
            files: st.files.load(Ordering::Relaxed),
            dirs: st.dirs.load(Ordering::Relaxed),
            bytes: st.bytes.load(Ordering::Relaxed),
            errors: st.errors.load(Ordering::Relaxed),
            elapsed_ms: st.elapsed(),
            done,
            cancelled: st.cancel.load(Ordering::SeqCst),
            current: if done { String::new() } else { scanner::current_path(&st) },
            view: &view,
        };
        let _ = app.emit("scan-progress", payload);
        if done {
            break;
        }
    });
    Ok(id)
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    if let Some(st) = state.scan.lock().as_ref() {
        st.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command(async)]
fn set_view(
    state: State<AppState>,
    node: u32,
    depth: u32,
    by_alloc: bool,
) -> Result<scanner::ViewSnapshot, String> {
    let st = state.current()?;
    *state.view.lock() = ViewReq { node, depth, by_alloc };
    Ok(scanner::snapshot(&st, node, depth, by_alloc))
}

#[tauri::command(async)]
fn get_top_files(state: State<AppState>, limit: usize) -> Result<Vec<scanner::Hit>, String> {
    Ok(scanner::top_files(&*state.current()?, limit))
}

#[tauri::command(async)]
fn search_nodes(
    state: State<AppState>,
    query: String,
    limit: usize,
) -> Result<scanner::SearchResult, String> {
    Ok(scanner::search(&*state.current()?, &query, limit))
}

#[tauri::command(async)]
fn get_node_details(state: State<AppState>, id: u32) -> Result<scanner::NodeDetails, String> {
    scanner::node_details(&*state.current()?, id)
}

#[tauri::command(async)]
fn get_scan_summary(state: State<AppState>) -> Result<scanner::ScanSummary, String> {
    Ok(scanner::summary(&*state.current()?))
}

#[tauri::command(async)]
fn open_in_explorer(path: String) -> Result<(), String> {
    cleaner::open_in_explorer(&path)
}

#[tauri::command(async)]
fn move_to_trash(state: State<AppState>, path: String, node_id: Option<u32>) -> Result<(), String> {
    cleaner::move_to_trash(&path)?;
    if let (Some(id), Ok(st)) = (node_id, state.current()) {
        scanner::remove_node(&st, id);
    }
    Ok(())
}

#[tauri::command(async)]
fn run_system_cleanup_cmd(id: String) -> Result<String, String> {
    cleaner::run_system_cleanup_cmd(&id)
}

#[tauri::command(async)]
fn scan_safe_caches() -> Vec<cleaner::CacheTarget> {
    cleaner::scan_safe_caches()
}

#[tauri::command(async)]
fn clean_safe_caches(ids: Vec<String>) -> cleaner::CleanResult {
    cleaner::clean_safe_caches(&ids)
}

#[tauri::command(async)]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| format!("클립보드 복사 실패: {}", e))
}

/// `--scan <경로>` 인자로 실행된 경우 시작과 동시에 스캔할 경로.
#[tauri::command]
fn initial_scan_path() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == "--scan")
        .and_then(|i| args.get(i + 1))
        .map(|p| winutil::normalize_root(p))
}

#[tauri::command]
fn is_elevated() -> bool {
    winutil::is_elevated()
}

#[tauri::command]
fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    winutil::relaunch_elevated()?;
    app.exit(0);
    Ok(())
}

#[tauri::command(async)]
fn load_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command(async)]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    settings::save(&app, &settings)
}

#[tauri::command]
async fn llm_chat(
    app: AppHandle,
    system: String,
    messages: Vec<llm::ChatMessage>,
    want_json: bool,
) -> Result<String, String> {
    let s = settings::load(&app);
    llm::chat(&s, &system, &messages, want_json).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            scan: Mutex::new(None),
            view: Mutex::new(ViewReq { node: 0, depth: 3, by_alloc: true }),
            seq: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            list_drives,
            pick_folder,
            start_scan,
            cancel_scan,
            set_view,
            get_top_files,
            search_nodes,
            get_node_details,
            get_scan_summary,
            open_in_explorer,
            move_to_trash,
            run_system_cleanup_cmd,
            scan_safe_caches,
            clean_safe_caches,
            copy_text,
            initial_scan_path,
            is_elevated,
            restart_as_admin,
            load_settings,
            save_settings,
            llm_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SpaceSense AI");
}
