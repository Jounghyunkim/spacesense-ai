//! 고속 병렬 디스크 스캐너.
//!
//! - 디렉토리 핸들 1개당 `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)` 로
//!   항목을 대량(64KB 버퍼) 열거한다. 파일을 개별적으로 열지 않고도 논리 크기,
//!   실제 할당 크기, 속성, 시간, File ID 를 한 번에 얻는다.
//! - 해당 정보 클래스를 지원하지 않는 파일시스템(일부 네트워크/FAT)은
//!   `FindFirstFileExW(FindExInfoBasic, LARGE_FETCH)` 로 폴백한다.
//! - Reparse Point(심볼릭 링크/정션/마운트 지점)는 따라가지 않는다.
//! - File ID 집합으로 하드링크 중복 집계를 막는다(WinSxS 등).
//! - 열거 계층(`enumerate_dir`)이 트리 집계와 분리되어 있어, 관리자 권한에서
//!   NTFS MFT 직접 파싱 백엔드를 같은 `RawEntry` 스트림으로 끼워 넣을 수 있다.

use parking_lot::{Condvar, Mutex, RwLock};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::hash::{BuildHasherDefault, Hasher};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileIdBothDirectoryInfo, FindClose, FindExInfoBasic, FindExSearchNameMatch,
    FindFirstFileExW, FindNextFileW, GetCompressedFileSizeW, GetFileInformationByHandleEx,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_BOTH_DIR_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FIND_FIRST_EX_LARGE_FETCH, OPEN_EXISTING, WIN32_FIND_DATAW,
};

use crate::winutil;

const FILE_LIST_DIRECTORY: u32 = 0x0001;
const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_REPARSE: u32 = 0x400;
const ATTR_SPARSE: u32 = 0x200;
const ATTR_COMPRESSED: u32 = 0x800;

pub const F_DIR: u8 = 1;
pub const F_REPARSE: u8 = 2;
pub const F_HARDLINK: u8 = 4;
pub const F_DELETED: u8 = 8;
pub const F_DENIED: u8 = 16;

pub const NO_PARENT: u32 = u32::MAX;
const TOP_N: usize = 100;
const TOP_MIN_SIZE: u64 = 1 << 20;
const SEEN_SHARDS: usize = 64;

pub struct Node {
    pub name: Box<str>,
    pub parent: u32,
    pub children: Vec<u32>,
    /// 논리 크기 (디렉토리는 하위 합계)
    pub size: u64,
    /// 디스크 할당 크기 (디렉토리는 하위 합계)
    pub alloc: u64,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub atime: u32,
    pub flags: u8,
}

pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    pub fn path_of(&self, id: u32, root_path: &str) -> String {
        if id == 0 {
            return root_path.to_string();
        }
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = id;
        while cur != 0 && cur != NO_PARENT {
            let n = &self.nodes[cur as usize];
            parts.push(&n.name);
            cur = n.parent;
        }
        let mut s = root_path.trim_end_matches('\\').to_string();
        for p in parts.iter().rev() {
            s.push('\\');
            s.push_str(p);
        }
        s
    }
}

#[derive(Default)]
struct IdHasher(u64);
impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 << 8) ^ *b as u64;
        }
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = v.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
type IdSet = HashSet<u64, BuildHasherDefault<IdHasher>>;

struct Job {
    node: u32,
    /// `\\?\` 확장 경로 (NUL 없음)
    path: Vec<u16>,
}

pub struct ScanState {
    pub id: u64,
    pub root_path: String,
    pub tree: RwLock<Tree>,
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub cancel: AtomicBool,
    pub done: AtomicBool,
    pub started: Instant,
    pub elapsed_ms: AtomicU64,
    pub current_node: AtomicU32,
    top: Mutex<Vec<(u64, u32)>>,
    top_min: AtomicU64,
    seen: Vec<Mutex<IdSet>>,
    cluster: u64,
    queue: Mutex<Vec<Job>>,
    cv: Condvar,
    pending: AtomicUsize,
}

impl ScanState {
    pub fn new(id: u64, root_path: String) -> Self {
        let cluster = winutil::cluster_size(&root_path);
        let root = Node {
            name: root_path.clone().into_boxed_str(),
            parent: NO_PARENT,
            children: Vec::new(),
            size: 0,
            alloc: 0,
            files: 0,
            dirs: 0,
            mtime: 0,
            atime: 0,
            flags: F_DIR,
        };
        ScanState {
            id,
            tree: RwLock::new(Tree { nodes: vec![root] }),
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            done: AtomicBool::new(false),
            started: Instant::now(),
            elapsed_ms: AtomicU64::new(0),
            current_node: AtomicU32::new(0),
            top: Mutex::new(Vec::with_capacity(TOP_N + 1)),
            top_min: AtomicU64::new(TOP_MIN_SIZE),
            seen: (0..SEEN_SHARDS).map(|_| Mutex::new(IdSet::default())).collect(),
            cluster,
            queue: Mutex::new(vec![Job { node: 0, path: winutil::to_extended(&root_path) }]),
            cv: Condvar::new(),
            pending: AtomicUsize::new(1),
            root_path,
        }
    }

    pub fn elapsed(&self) -> u64 {
        if self.done.load(Ordering::Relaxed) {
            self.elapsed_ms.load(Ordering::Relaxed)
        } else {
            self.started.elapsed().as_millis() as u64
        }
    }
}

// ---------------------------------------------------------------------------
// 디렉토리 열거 계층
// ---------------------------------------------------------------------------

pub struct RawEntry {
    pub name: String,
    pub attrs: u32,
    pub size: u64,
    pub alloc: u64,
    pub mtime: u32,
    pub atime: u32,
    pub file_id: u64,
}

thread_local! {
    static DIR_BUF: RefCell<Vec<u64>> = RefCell::new(vec![0u64; 8192]);
}

fn filetime_to_unix(ft: i64) -> u32 {
    let secs = ft / 10_000_000 - 11_644_473_600;
    secs.clamp(0, u32::MAX as i64) as u32
}

fn is_dot(name: &[u16]) -> bool {
    matches!(name, [0x2E] | [0x2E, 0x2E])
}

/// 한 디렉토리의 직계 항목을 열거한다. `path` 는 `\\?\` 확장 경로(NUL 없음).
pub fn enumerate_dir(path: &[u16], cluster: u64, out: &mut Vec<RawEntry>) -> Result<(), u32> {
    let mut z: Vec<u16> = Vec::with_capacity(path.len() + 3);
    z.extend_from_slice(path);
    z.push(0);
    unsafe {
        let h = CreateFileW(
            z.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        );
        if h == INVALID_HANDLE_VALUE {
            return Err(GetLastError());
        }
        let supported = DIR_BUF.with(|cell| {
            let mut buf = cell.borrow_mut();
            let bytes = (buf.len() * 8) as u32;
            let mut first = true;
            loop {
                let ok = GetFileInformationByHandleEx(
                    h,
                    FileIdBothDirectoryInfo,
                    buf.as_mut_ptr() as *mut c_void,
                    bytes,
                );
                if ok == 0 {
                    let e = GetLastError();
                    // 첫 호출부터 실패하면 미지원 파일시스템으로 보고 폴백한다.
                    return !(first && e != ERROR_NO_MORE_FILES);
                }
                first = false;
                let mut p = buf.as_ptr() as *const u8;
                loop {
                    let info = p as *const FILE_ID_BOTH_DIR_INFO;
                    let name_len = ((*info).FileNameLength / 2) as usize;
                    let name_ptr = std::ptr::addr_of!((*info).FileName) as *const u16;
                    let name = std::slice::from_raw_parts(name_ptr, name_len);
                    if !is_dot(name) {
                        out.push(RawEntry {
                            name: String::from_utf16_lossy(name),
                            attrs: (*info).FileAttributes,
                            size: (*info).EndOfFile.max(0) as u64,
                            alloc: (*info).AllocationSize.max(0) as u64,
                            mtime: filetime_to_unix((*info).LastWriteTime),
                            atime: filetime_to_unix((*info).LastAccessTime),
                            file_id: (*info).FileId as u64,
                        });
                    }
                    let next = (*info).NextEntryOffset as usize;
                    if next == 0 {
                        break;
                    }
                    p = p.add(next);
                }
            }
        });
        CloseHandle(h);
        if supported {
            return Ok(());
        }
    }
    out.clear();
    enumerate_dir_find(path, cluster, out)
}

/// 폴백 열거: FindFirstFileExW. 할당 크기는 클러스터 올림으로 근사하고,
/// 압축/스파스 파일만 GetCompressedFileSizeW 로 실제 값을 구한다.
fn enumerate_dir_find(path: &[u16], cluster: u64, out: &mut Vec<RawEntry>) -> Result<(), u32> {
    let mut pattern: Vec<u16> = path.to_vec();
    if pattern.last() != Some(&0x5C) {
        pattern.push(0x5C);
    }
    let base_len = pattern.len();
    pattern.push(0x2A);
    pattern.push(0);
    unsafe {
        let mut data: WIN32_FIND_DATAW = std::mem::zeroed();
        let h = FindFirstFileExW(
            pattern.as_ptr(),
            FindExInfoBasic,
            &mut data as *mut _ as *mut c_void,
            FindExSearchNameMatch,
            null(),
            FIND_FIRST_EX_LARGE_FETCH,
        );
        if h == INVALID_HANDLE_VALUE {
            let e = GetLastError();
            // 2 = ERROR_FILE_NOT_FOUND: 빈 디렉토리
            return if e == 2 { Ok(()) } else { Err(e) };
        }
        loop {
            let len = data.cFileName.iter().position(|&c| c == 0).unwrap_or(260);
            let name = &data.cFileName[..len];
            if !is_dot(name) {
                let size = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
                let attrs = data.dwFileAttributes;
                let mut alloc = if cluster > 0 { size.div_ceil(cluster) * cluster } else { size };
                if attrs & (ATTR_COMPRESSED | ATTR_SPARSE) != 0 && attrs & ATTR_DIRECTORY == 0 {
                    let mut full: Vec<u16> = pattern[..base_len].to_vec();
                    full.extend_from_slice(name);
                    full.push(0);
                    let mut high = 0u32;
                    let low = GetCompressedFileSizeW(full.as_ptr(), &mut high);
                    if !(low == u32::MAX && GetLastError() != 0) {
                        alloc = ((high as u64) << 32) | low as u64;
                    }
                }
                let ft = |f: windows_sys::Win32::Foundation::FILETIME| {
                    filetime_to_unix((((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64) as i64)
                };
                out.push(RawEntry {
                    name: String::from_utf16_lossy(name),
                    attrs,
                    size,
                    alloc,
                    mtime: ft(data.ftLastWriteTime),
                    atime: ft(data.ftLastAccessTime),
                    file_id: 0,
                });
            }
            if FindNextFileW(h, &mut data) == 0 {
                break;
            }
        }
        FindClose(h);
    }
    Ok(())
}

fn join_path(parent: &[u16], name: &str) -> Vec<u16> {
    let mut p = Vec::with_capacity(parent.len() + name.len() + 1);
    p.extend_from_slice(parent);
    if p.last() != Some(&0x5C) {
        p.push(0x5C);
    }
    p.extend(name.encode_utf16());
    p
}

/// 트리를 만들지 않고 폴더 전체 크기만 구한다 (캐시 정리 미리보기용).
pub fn dir_size(path: &str) -> (u64, u64) {
    let cluster = winutil::cluster_size(path);
    let mut stack = vec![winutil::to_extended(path)];
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut entries = Vec::new();
    while let Some(dir) = stack.pop() {
        entries.clear();
        if enumerate_dir(&dir, cluster, &mut entries).is_err() {
            continue;
        }
        for e in &entries {
            if e.attrs & ATTR_DIRECTORY != 0 {
                if e.attrs & ATTR_REPARSE == 0 {
                    stack.push(join_path(&dir, &e.name));
                }
            } else {
                bytes += e.alloc;
                files += 1;
            }
        }
    }
    (bytes, files)
}

// ---------------------------------------------------------------------------
// 병렬 스캔
// ---------------------------------------------------------------------------

/// 스캔을 끝까지(또는 취소될 때까지) 실행한다. 호출 스레드를 블록한다.
pub fn run(st: &ScanState) {
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 16);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| worker(st));
        }
    });
    st.elapsed_ms.store(st.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    st.done.store(true, Ordering::SeqCst);
}

fn worker(st: &ScanState) {
    let mut entries: Vec<RawEntry> = Vec::new();
    loop {
        let job = {
            let mut q = st.queue.lock();
            loop {
                if st.cancel.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(j) = q.pop() {
                    break j;
                }
                if st.pending.load(Ordering::SeqCst) == 0 {
                    return;
                }
                st.cv.wait_for(&mut q, Duration::from_millis(50));
            }
        };
        entries.clear();
        process_dir(st, &job, &mut entries);
        if st.pending.fetch_sub(1, Ordering::SeqCst) == 1 {
            st.cv.notify_all();
        }
    }
}

fn process_dir(st: &ScanState, job: &Job, entries: &mut Vec<RawEntry>) {
    st.current_node.store(job.node, Ordering::Relaxed);
    if enumerate_dir(&job.path, st.cluster, entries).is_err() {
        st.errors.fetch_add(1, Ordering::Relaxed);
        st.tree.write().nodes[job.node as usize].flags |= F_DENIED;
        return;
    }

    // 하드링크 중복 제거: 같은 File ID 를 두 번째로 만나면 크기를 0 으로 집계한다.
    let mut hardlink = vec![false; entries.len()];
    for (i, e) in entries.iter_mut().enumerate() {
        if e.attrs & ATTR_DIRECTORY == 0 && e.file_id != 0 && e.size > 0 {
            let shard = (e.file_id as usize ^ (e.file_id >> 20) as usize) % SEEN_SHARDS;
            if !st.seen[shard].lock().insert(e.file_id) {
                e.size = 0;
                e.alloc = 0;
                hardlink[i] = true;
            }
        }
    }

    let (mut sum_size, mut sum_alloc, mut n_files, mut n_dirs) = (0u64, 0u64, 0u32, 0u32);
    let (mut max_m, mut max_a) = (0u32, 0u32);
    let mut subdirs: Vec<(u32, usize)> = Vec::new();
    {
        let mut t = st.tree.write();
        let base = t.nodes.len() as u32;
        t.nodes.reserve(entries.len());
        let mut child_ids = Vec::with_capacity(entries.len());
        for (i, e) in entries.iter().enumerate() {
            let id = base + i as u32;
            let is_dir = e.attrs & ATTR_DIRECTORY != 0;
            let reparse = e.attrs & ATTR_REPARSE != 0;
            let mut flags = 0u8;
            if is_dir {
                flags |= F_DIR;
                n_dirs += 1;
                if !reparse {
                    subdirs.push((id, i));
                }
            } else {
                n_files += 1;
                sum_size += e.size;
                sum_alloc += e.alloc;
                max_m = max_m.max(e.mtime);
                max_a = max_a.max(e.atime);
                if e.size >= st.top_min.load(Ordering::Relaxed) {
                    push_top(st, e.size, id);
                }
            }
            if reparse {
                flags |= F_REPARSE;
            }
            if hardlink[i] {
                flags |= F_HARDLINK;
            }
            t.nodes.push(Node {
                name: e.name.as_str().into(),
                parent: job.node,
                children: Vec::new(),
                size: if is_dir { 0 } else { e.size },
                alloc: if is_dir { 0 } else { e.alloc },
                files: 0,
                dirs: 0,
                mtime: e.mtime,
                atime: e.atime,
                flags,
            });
            child_ids.push(id);
        }
        t.nodes[job.node as usize].children = child_ids;
        // 직계 파일 합계를 조상 체인에 누적
        let mut cur = job.node;
        while cur != NO_PARENT {
            let n = &mut t.nodes[cur as usize];
            n.size += sum_size;
            n.alloc += sum_alloc;
            n.files += n_files;
            n.dirs += n_dirs;
            n.mtime = n.mtime.max(max_m);
            n.atime = n.atime.max(max_a);
            cur = n.parent;
        }
    }
    st.files.fetch_add(n_files as u64, Ordering::Relaxed);
    st.dirs.fetch_add(n_dirs as u64, Ordering::Relaxed);
    st.bytes.fetch_add(sum_alloc, Ordering::Relaxed);

    if !subdirs.is_empty() {
        let jobs: Vec<Job> = subdirs
            .iter()
            .map(|&(id, i)| Job { node: id, path: join_path(&job.path, &entries[i].name) })
            .collect();
        st.pending.fetch_add(jobs.len(), Ordering::SeqCst);
        st.queue.lock().extend(jobs);
        st.cv.notify_all();
    }
}

fn push_top(st: &ScanState, size: u64, id: u32) {
    let mut top = st.top.lock();
    if top.len() < TOP_N {
        top.push((size, id));
        return;
    }
    let (mut min_i, mut min_v) = (0usize, u64::MAX);
    for (i, &(s, _)) in top.iter().enumerate() {
        if s < min_v {
            min_v = s;
            min_i = i;
        }
    }
    if size > min_v {
        top[min_i] = (size, id);
        let new_min = top.iter().map(|x| x.0).min().unwrap_or(TOP_MIN_SIZE);
        st.top_min.store(new_min.max(TOP_MIN_SIZE), Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// 뷰 스냅샷 (Treemap 용, 가지치기된 부분 트리)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewNode {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub atime: u32,
    pub is_dir: bool,
    pub flags: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ViewNode>>,
    pub other_count: u32,
    pub other_size: u64,
    pub other_alloc: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub id: u32,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSnapshot {
    pub root: ViewNode,
    pub path: String,
    pub crumbs: Vec<Crumb>,
    pub scan_size: u64,
    pub scan_alloc: u64,
}

const ROOT_MAX_CHILDREN: usize = 500;
const SUB_MAX_CHILDREN: usize = 300;

fn build_view(t: &Tree, id: u32, depth: u32, by_alloc: bool, min: u64, is_root: bool) -> ViewNode {
    let n = &t.nodes[id as usize];
    let mut v = ViewNode {
        id,
        name: n.name.to_string(),
        size: n.size,
        alloc: n.alloc,
        files: n.files,
        dirs: n.dirs,
        mtime: n.mtime,
        atime: n.atime,
        is_dir: n.flags & F_DIR != 0,
        flags: n.flags,
        children: None,
        other_count: 0,
        other_size: 0,
        other_alloc: 0,
    };
    if v.is_dir && depth > 0 && !n.children.is_empty() {
        let metric = |c: u32| {
            let k = &t.nodes[c as usize];
            if by_alloc { k.alloc } else { k.size }
        };
        let mut kids: Vec<u32> = n.children.clone();
        kids.sort_unstable_by(|a, b| metric(*b).cmp(&metric(*a)));
        let cap = if is_root { ROOT_MAX_CHILDREN } else { SUB_MAX_CHILDREN };
        let mut out = Vec::new();
        for (i, &c) in kids.iter().enumerate() {
            let m = metric(c);
            if i < cap && (is_root || (m >= min && m > 0)) {
                out.push(build_view(t, c, depth - 1, by_alloc, min, false));
            } else {
                let k = &t.nodes[c as usize];
                v.other_count += 1;
                v.other_size += k.size;
                v.other_alloc += k.alloc;
            }
        }
        v.children = Some(out);
    }
    v
}

pub fn snapshot(st: &ScanState, node: u32, depth: u32, by_alloc: bool) -> ViewSnapshot {
    let t = st.tree.read();
    let node = if (node as usize) < t.nodes.len() && t.nodes[node as usize].flags & F_DELETED == 0 {
        node
    } else {
        0
    };
    let n = &t.nodes[node as usize];
    let total = if by_alloc { n.alloc } else { n.size };
    let min = total / 6000;
    let root = build_view(&t, node, depth.clamp(1, 5), by_alloc, min, true);
    let mut crumbs = Vec::new();
    let mut cur = node;
    while cur != NO_PARENT {
        let c = &t.nodes[cur as usize];
        crumbs.push(Crumb { id: cur, name: c.name.to_string() });
        cur = c.parent;
    }
    crumbs.reverse();
    ViewSnapshot {
        root,
        path: t.path_of(node, &st.root_path),
        crumbs,
        scan_size: t.nodes[0].size,
        scan_alloc: t.nodes[0].alloc,
    }
}

pub fn current_path(st: &ScanState) -> String {
    let t = st.tree.read();
    let id = st.current_node.load(Ordering::Relaxed);
    if (id as usize) < t.nodes.len() {
        t.path_of(id, &st.root_path)
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Top-N / 검색
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: u32,
    pub parent: u32,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub atime: u32,
    pub is_dir: bool,
}

fn make_hit(t: &Tree, root: &str, id: u32) -> Hit {
    let n = &t.nodes[id as usize];
    Hit {
        id,
        parent: n.parent,
        name: n.name.to_string(),
        path: t.path_of(id, root),
        size: n.size,
        alloc: n.alloc,
        files: n.files,
        dirs: n.dirs,
        mtime: n.mtime,
        atime: n.atime,
        is_dir: n.flags & F_DIR != 0,
    }
}

pub fn top_files(st: &ScanState, limit: usize) -> Vec<Hit> {
    let mut list: Vec<(u64, u32)> = st.top.lock().clone();
    list.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let t = st.tree.read();
    list.iter()
        .filter(|(_, id)| t.nodes[*id as usize].flags & F_DELETED == 0)
        .take(limit)
        .map(|&(_, id)| make_hit(&t, &st.root_path, id))
        .collect()
}

fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim().to_ascii_lowercase();
    let split = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let num: f64 = s[..split].parse().ok()?;
    let mult = match s[split..].trim() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0 * 1024.0,
        "g" | "gb" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" => 1024.0f64.powi(4),
        _ => return None,
    };
    Some((num * mult) as u64)
}

/// `*`, `?` 와일드카드 매칭 (소문자화된 입력 기준).
fn wildcard(pat: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while t < text.len() {
        if p < pat.len() && (pat[p] == '?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == '*' {
            star = p;
            mark = t;
            p += 1;
        } else if star != usize::MAX {
            p = star + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == '*' {
        p += 1;
    }
    p == pat.len()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub total: usize,
    pub hits: Vec<Hit>,
}

/// 검색 문법: 공백으로 구분된 토큰. `*.vhdx`(와일드카드), `log`(부분 문자열),
/// `>1GB` / `<10MB`(크기 필터). 모든 토큰을 만족해야 한다.
pub fn search(st: &ScanState, query: &str, limit: usize) -> SearchResult {
    let mut globs: Vec<Vec<char>> = Vec::new();
    let mut subs: Vec<String> = Vec::new();
    let (mut min, mut max) = (0u64, u64::MAX);
    for tok in query.split_whitespace() {
        if let Some(rest) = tok.strip_prefix('>') {
            if let Some(v) = parse_size(rest.trim_start_matches('=')) {
                min = v;
                continue;
            }
        }
        if let Some(rest) = tok.strip_prefix('<') {
            if let Some(v) = parse_size(rest.trim_start_matches('=')) {
                max = v;
                continue;
            }
        }
        let low = tok.to_lowercase();
        if low.contains('*') || low.contains('?') {
            globs.push(low.chars().collect());
        } else {
            subs.push(low);
        }
    }
    let name_filter = !globs.is_empty() || !subs.is_empty();
    if !name_filter && min == 0 && max == u64::MAX {
        return SearchResult { total: 0, hits: Vec::new() };
    }
    let t = st.tree.read();
    let mut matched: Vec<(u64, u32)> = Vec::new();
    for (i, n) in t.nodes.iter().enumerate().skip(1) {
        if n.flags & F_DELETED != 0 {
            continue;
        }
        let is_dir = n.flags & F_DIR != 0;
        if is_dir && !name_filter {
            continue;
        }
        if n.size < min || n.size > max {
            continue;
        }
        if name_filter {
            let low = n.name.to_lowercase();
            if !subs.iter().all(|s| low.contains(s.as_str())) {
                continue;
            }
            if !globs.is_empty() {
                let chars: Vec<char> = low.chars().collect();
                if !globs.iter().all(|g| wildcard(g, &chars)) {
                    continue;
                }
            }
        }
        matched.push((n.size, i as u32));
    }
    let total = matched.len();
    matched.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    matched.truncate(limit);
    SearchResult {
        total,
        hits: matched.iter().map(|&(_, id)| make_hit(&t, &st.root_path, id)).collect(),
    }
}

// ---------------------------------------------------------------------------
// AI 컨텍스트: 노드 상세 / 스캔 요약
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtStat {
    pub ext: String,
    pub count: u32,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub name: String,
    pub size: u64,
    pub mtime: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildStat {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub files: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetails {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub atime: u32,
    pub percent_of_scan: f64,
    pub ext_stats: Vec<ExtStat>,
    pub samples: Vec<Sample>,
    pub top_children: Vec<ChildStat>,
    pub truncated: bool,
}

fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 12 => name[i..].to_lowercase(),
        _ => "(확장자 없음)".to_string(),
    }
}

pub fn node_details(st: &ScanState, id: u32) -> Result<NodeDetails, String> {
    const VISIT_CAP: usize = 400_000;
    let t = st.tree.read();
    let n = t.nodes.get(id as usize).ok_or("존재하지 않는 항목입니다.")?;
    if n.flags & F_DELETED != 0 {
        return Err("이미 삭제된 항목입니다.".into());
    }
    let is_dir = n.flags & F_DIR != 0;
    let mut exts: HashMap<String, (u32, u64)> = HashMap::new();
    let mut samples: Vec<(u64, u32)> = Vec::new();
    let mut truncated = false;
    if is_dir {
        let mut stack = vec![id];
        let mut visited = 0usize;
        while let Some(cur) = stack.pop() {
            for &c in &t.nodes[cur as usize].children {
                visited += 1;
                let k = &t.nodes[c as usize];
                if k.flags & F_DIR != 0 {
                    stack.push(c);
                } else {
                    let e = exts.entry(ext_of(&k.name)).or_insert((0, 0));
                    e.0 += 1;
                    e.1 += k.alloc;
                    samples.push((k.alloc, c));
                    if samples.len() > 64 {
                        samples.sort_unstable_by(|a, b| b.0.cmp(&a.0));
                        samples.truncate(10);
                    }
                }
            }
            if visited > VISIT_CAP {
                truncated = true;
                break;
            }
        }
    }
    samples.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    samples.truncate(10);
    let mut ext_stats: Vec<ExtStat> =
        exts.into_iter().map(|(ext, (count, size))| ExtStat { ext, count, size }).collect();
    ext_stats.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    ext_stats.truncate(12);
    let mut kids: Vec<u32> = n.children.clone();
    kids.sort_unstable_by(|a, b| t.nodes[*b as usize].alloc.cmp(&t.nodes[*a as usize].alloc));
    let top_children = kids
        .iter()
        .take(15)
        .map(|&c| {
            let k = &t.nodes[c as usize];
            ChildStat { name: k.name.to_string(), is_dir: k.flags & F_DIR != 0, size: k.alloc, files: k.files }
        })
        .collect();
    let total = t.nodes[0].alloc.max(1);
    Ok(NodeDetails {
        id,
        name: n.name.to_string(),
        path: t.path_of(id, &st.root_path),
        is_dir,
        size: n.size,
        alloc: n.alloc,
        files: n.files,
        dirs: n.dirs,
        mtime: n.mtime,
        atime: n.atime,
        percent_of_scan: n.alloc as f64 * 100.0 / total as f64,
        ext_stats,
        samples: samples
            .iter()
            .map(|&(_, c)| {
                let k = &t.nodes[c as usize];
                Sample { name: k.name.to_string(), size: k.alloc, mtime: k.mtime }
            })
            .collect(),
        top_children,
        truncated,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumEntry {
    pub path: String,
    pub size: u64,
    pub files: u32,
    pub is_dir: bool,
    pub children: Vec<ChildStat>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub root_path: String,
    pub total_size: u64,
    pub total_alloc: u64,
    pub files: u64,
    pub dirs: u64,
    pub errors: u64,
    pub done: bool,
    pub top_dirs: Vec<SumEntry>,
    pub top_files: Vec<SumEntry>,
    pub cache_candidates: Vec<SumEntry>,
}

const CACHE_NAMES: &[&str] = &[
    "node_modules", ".venv", "venv", "__pycache__", ".gradle", "npm-cache", "temp", "tmp",
    "cache", ".cache", "crashdumps", "ms-playwright", "softwaredistribution", "pip", "uv",
    "code cache", "gpucache", "d3dscache", ".nuget", "windows.old", "$recycle.bin",
];

/// 자유 질문 채팅용 스캔 요약 (상위 폴더 2단계, 대용량 파일, 캐시 후보).
pub fn summary(st: &ScanState) -> ScanSummary {
    let t = st.tree.read();
    let root = &t.nodes[0];
    let child_stats = |id: u32, take: usize| -> Vec<ChildStat> {
        let mut kids: Vec<u32> = t.nodes[id as usize].children.clone();
        kids.sort_unstable_by(|a, b| t.nodes[*b as usize].alloc.cmp(&t.nodes[*a as usize].alloc));
        kids.iter()
            .take(take)
            .map(|&c| {
                let k = &t.nodes[c as usize];
                ChildStat { name: k.name.to_string(), is_dir: k.flags & F_DIR != 0, size: k.alloc, files: k.files }
            })
            .collect()
    };
    let entry = |id: u32, kids: usize| -> SumEntry {
        let n = &t.nodes[id as usize];
        SumEntry {
            path: t.path_of(id, &st.root_path),
            size: n.alloc,
            files: n.files,
            is_dir: n.flags & F_DIR != 0,
            children: if kids > 0 { child_stats(id, kids) } else { Vec::new() },
        }
    };
    let mut level1: Vec<u32> = root.children.clone();
    level1.sort_unstable_by(|a, b| t.nodes[*b as usize].alloc.cmp(&t.nodes[*a as usize].alloc));
    let top_dirs = level1.iter().take(20).map(|&id| entry(id, 8)).collect();

    let mut top: Vec<(u64, u32)> = st.top.lock().clone();
    top.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let top_files = top
        .iter()
        .filter(|(_, id)| t.nodes[*id as usize].flags & F_DELETED == 0)
        .take(25)
        .map(|&(_, id)| entry(id, 0))
        .collect();

    let mut cands: Vec<(u64, u32)> = Vec::new();
    for (i, n) in t.nodes.iter().enumerate().skip(1) {
        if n.flags & F_DIR == 0 || n.flags & F_DELETED != 0 || n.alloc < 50 * 1024 * 1024 {
            continue;
        }
        let low = n.name.to_lowercase();
        if CACHE_NAMES.contains(&low.as_str()) {
            cands.push((n.alloc, i as u32));
        }
    }
    cands.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    cands.truncate(60);
    let cache_candidates = cands.iter().map(|&(_, id)| entry(id, 0)).collect();

    ScanSummary {
        root_path: st.root_path.clone(),
        total_size: root.size,
        total_alloc: root.alloc,
        files: st.files.load(Ordering::Relaxed),
        dirs: st.dirs.load(Ordering::Relaxed),
        errors: st.errors.load(Ordering::Relaxed),
        done: st.done.load(Ordering::Relaxed),
        top_dirs,
        top_files,
        cache_candidates,
    }
}

/// 삭제된 항목을 트리에서 제거하고 조상 합계를 차감한다.
pub fn remove_node(st: &ScanState, id: u32) {
    let mut t = st.tree.write();
    if id == 0 || id as usize >= t.nodes.len() || t.nodes[id as usize].flags & F_DELETED != 0 {
        return;
    }
    let (size, alloc, files, dirs, parent) = {
        let n = &t.nodes[id as usize];
        let is_dir = n.flags & F_DIR != 0;
        (
            n.size,
            n.alloc,
            if is_dir { n.files } else { 1 },
            if is_dir { n.dirs + 1 } else { 0 },
            n.parent,
        )
    };
    let mut stack = vec![id];
    while let Some(cur) = stack.pop() {
        let n = &mut t.nodes[cur as usize];
        n.flags |= F_DELETED;
        stack.extend(std::mem::take(&mut n.children));
    }
    if parent != NO_PARENT {
        t.nodes[parent as usize].children.retain(|&c| c != id);
    }
    let mut cur = parent;
    while cur != NO_PARENT {
        let n = &mut t.nodes[cur as usize];
        n.size = n.size.saturating_sub(size);
        n.alloc = n.alloc.saturating_sub(alloc);
        n.files = n.files.saturating_sub(files);
        n.dirs = n.dirs.saturating_sub(dirs);
        cur = n.parent;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 실제 경로 벤치마크: `$env:SCAN_BENCH='C:\'; cargo test --release bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_scan() {
        let path = std::env::var("SCAN_BENCH").expect("SCAN_BENCH 경로 필요");
        let st = ScanState::new(1, winutil::normalize_root(&path));
        // 앱과 같은 조건: 200ms 마다 스냅샷을 뜨는 스레드를 함께 돌린다.
        std::thread::scope(|s| {
            s.spawn(|| {
                let (mut n, mut worst, mut total) = (0u32, 0u128, 0u128);
                while !st.done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(200));
                    let t0 = Instant::now();
                    let snap = snapshot(&st, 0, 3, true);
                    let json = serde_json::to_string(&snap).unwrap();
                    let d = t0.elapsed().as_millis();
                    n += 1;
                    worst = worst.max(d);
                    total += d;
                    std::hint::black_box(json.len());
                }
                println!("snapshots={} avg={}ms worst={}ms", n, total / n.max(1) as u128, worst);
            });
            run(&st);
        });
        let t = st.tree.read();
        println!(
            "files={} dirs={} alloc={:.2}GB errors={} elapsed={}ms",
            t.nodes[0].files,
            t.nodes[0].dirs,
            t.nodes[0].alloc as f64 / (1u64 << 30) as f64,
            st.errors.load(Ordering::Relaxed),
            st.elapsed()
        );
    }

    #[test]
    fn trash_guard_and_move() {
        use crate::cleaner;
        assert!(cleaner::protected_reason("C:\\").is_some());
        assert!(cleaner::protected_reason("C:\\Windows\\System32\\drivers").is_some());
        assert!(cleaner::protected_reason("c:\\program files").is_some());
        assert!(cleaner::protected_reason("C:\\hiberfil.sys").is_some());
        assert!(cleaner::protected_reason("C:\\Windows\\Temp\\foo.tmp").is_none());
        assert!(cleaner::protected_reason("D:\\proj\\node_modules").is_none());
        let f = std::env::temp_dir().join(format!("spacesense_trash_test_{}.tmp", std::process::id()));
        fs::write(&f, b"x").unwrap();
        cleaner::move_to_trash(&f.to_string_lossy()).unwrap();
        assert!(!f.exists());
    }

    #[test]
    fn scans_tree_and_aggregates() {
        let base = std::env::temp_dir().join(format!("spacesense_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a").join("b")).unwrap();
        fs::create_dir_all(base.join("한글 폴더")).unwrap();
        fs::write(base.join("root.bin"), vec![1u8; 10_000]).unwrap();
        fs::write(base.join("a").join("x.log"), vec![2u8; 5_000]).unwrap();
        fs::write(base.join("a").join("b").join("y.vhdx"), vec![3u8; 2_000_000]).unwrap();
        fs::write(base.join("한글 폴더").join("z.txt"), vec![4u8; 123]).unwrap();
        // 하드링크: 두 번 집계되면 안 된다
        fs::hard_link(base.join("root.bin"), base.join("a").join("link.bin")).unwrap();

        let st = ScanState::new(1, winutil::normalize_root(&base.to_string_lossy()));
        run(&st);
        assert!(st.done.load(Ordering::SeqCst));
        {
            let t = st.tree.read();
            assert_eq!(t.nodes[0].files, 5);
            assert_eq!(t.nodes[0].dirs, 3);
            assert_eq!(t.nodes[0].size, 10_000 + 5_000 + 2_000_000 + 123);
            assert!(t.nodes[0].alloc >= 2_000_000);
        }
        let snap = snapshot(&st, 0, 3, true);
        assert_eq!(snap.root.children.as_ref().unwrap().len(), 3);
        let top = top_files(&st, 10);
        assert_eq!(top[0].name, "y.vhdx");
        assert!(top[0].path.ends_with("a\\b\\y.vhdx"));
        assert_eq!(search(&st, "*.vhdx", 10).total, 1);
        assert_eq!(search(&st, ">1MB", 10).total, 1);
        assert_eq!(search(&st, "한글", 10).total, 1);
        let d = node_details(&st, 0).unwrap();
        assert!(d.ext_stats.iter().any(|e| e.ext == ".vhdx"));

        let id = top[0].id;
        remove_node(&st, id);
        assert_eq!(st.tree.read().nodes[0].files, 4);
        assert_eq!(dir_size(&base.to_string_lossy()).1, 5);
        let _ = fs::remove_dir_all(&base);
    }
}
