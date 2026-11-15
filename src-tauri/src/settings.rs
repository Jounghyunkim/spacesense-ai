//! LLM 설정 저장소. API 키는 Windows DPAPI 로 암호화해 디스크에 저장한다.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::winutil::{dpapi_decrypt, dpapi_encrypt};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "ollama" | "openai" | "anthropic"
    pub provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub openai_base_url: String,
    pub openai_key: String,
    pub openai_model: String,
    pub anthropic_key: String,
    pub anthropic_model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "ollama".into(),
            ollama_url: "http://localhost:11434".into(),
            ollama_model: "llama3.1".into(),
            openai_base_url: "https://api.openai.com/v1".into(),
            openai_key: String::new(),
            openai_model: "gpt-4o-mini".into(),
            anthropic_key: String::new(),
            anthropic_model: "claude-opus-5-5".into(),
        }
    }
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = file_path(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    let mut s: Settings = serde_json::from_str(&text).unwrap_or_default();
    s.openai_key = dpapi_decrypt(&s.openai_key);
    s.anthropic_key = dpapi_decrypt(&s.anthropic_key);
    s
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let mut s = settings.clone();
    s.openai_key = dpapi_encrypt(s.openai_key.trim());
    s.anthropic_key = dpapi_encrypt(s.anthropic_key.trim());
    let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(file_path(app)?, text).map_err(|e| e.to_string())
}
