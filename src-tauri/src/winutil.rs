//! Win32 헬퍼: 와이드 문자열, 드라이브 정보, 권한 상승 확인, DPAPI 암호화.

use serde::Serialize;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetLogicalDrives,
    GetVolumeInformationW, GetVolumePathNameW,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::ShellExecuteW;

/// NUL 종료 UTF-16 문자열.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// MAX_PATH 제한을 피하기 위한 `\\?\` 확장 경로 (NUL 없음).
pub fn to_extended(path: &str) -> Vec<u16> {
    let p = path.replace('/', "\\");
    let s = if p.starts_with(r"\\?\") {
        p
    } else if let Some(rest) = p.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{}", rest)
    } else {
        format!(r"\\?\{}", p)
    };
    s.encode_utf16().collect()
}

/// 스캔 루트 경로 정규화: `C:` -> `C:\`, `D:\foo\` -> `D:\foo`.
pub fn normalize_root(path: &str) -> String {
    let mut p = path.trim().replace('/', "\\");
    while p.len() > 3 && p.ends_with('\\') {
        p.pop();
    }
    if p.len() == 2 && p.ends_with(':') {
        p.push('\\');
    }
    p
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
    pub fs: String,
    pub total: u64,
    pub free: u64,
    pub kind: String,
}

fn from_wide_buf(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let path = format!("{}:\\", (b'A' + i as u8) as char);
        let w = wide(&path);
        let dtype = unsafe { GetDriveTypeW(w.as_ptr()) };
        let kind = match dtype {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "cdrom",
            6 => "ramdisk",
            _ => continue,
        };
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
        if ok == 0 || total == 0 {
            continue; // 미디어 없음
        }
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                null_mut(),
                null_mut(),
                null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            );
        }
        out.push(DriveInfo {
            path,
            label: from_wide_buf(&label),
            fs: from_wide_buf(&fs),
            total,
            free,
            kind: kind.to_string(),
        });
    }
    out
}

/// 경로가 속한 볼륨의 클러스터 크기 (실패 시 4096).
pub fn cluster_size(path: &str) -> u64 {
    let w = wide(path);
    let mut vol = [0u16; 512];
    let ok = unsafe { GetVolumePathNameW(w.as_ptr(), vol.as_mut_ptr(), vol.len() as u32) };
    let root_ptr = if ok != 0 { vol.as_ptr() } else { w.as_ptr() };
    let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
    let ok = unsafe { GetDiskFreeSpaceW(root_ptr, &mut spc, &mut bps, &mut fc, &mut tc) };
    if ok != 0 && spc > 0 && bps > 0 {
        spc as u64 * bps as u64
    } else {
        4096
    }
}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elev as *mut _ as *mut c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && elev.TokenIsElevated != 0
    }
}

/// 현재 실행 파일을 관리자 권한(UAC)으로 다시 실행.
pub fn relaunch_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_w = wide(&exe.to_string_lossy());
    let verb = wide("runas");
    let r = unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), exe_w.as_ptr(), null(), null(), 1) };
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err("관리자 권한 실행이 취소되었거나 실패했습니다.".into())
    }
}

fn hex_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// DPAPI(현재 Windows 사용자 계정 범위)로 암호화한 hex 문자열.
pub fn dpapi_encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = CryptProtectData(&input, null(), null(), null(), null(), 0, &mut output);
        if ok == 0 || output.pbData.is_null() {
            return String::new();
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut c_void);
        hex_encode(&bytes)
    }
}

pub fn dpapi_decrypt(hex: &str) -> String {
    let Some(data) = hex_decode(hex) else {
        return String::new();
    };
    if data.is_empty() {
        return String::new();
    }
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output);
        if ok == 0 || output.pbData.is_null() {
            return String::new();
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut c_void);
        String::from_utf8(bytes).unwrap_or_default()
    }
}
