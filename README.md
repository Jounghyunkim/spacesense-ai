# SpaceSense AI

Windows x64용 디스크 공간 분석·정리 앱입니다. SpaceSniffer 방식의 실시간 Treemap, 고속 병렬 스캐너, 우측 AI Storage Advisor 패널로 구성됩니다. (Tauri v2 + Rust + React 19 + TypeScript + Tailwind CSS)

## 실행

- 설치 없이 실행: `src-tauri\target\release\spacesense-ai.exe`
- 설치 프로그램: `src-tauri\target\release\bundle\nsis\SpaceSense AI_1.0.0_x64-setup.exe`
- 시작과 동시에 스캔: `spacesense-ai.exe --scan D:\Projects`

WebView2 런타임이 필요합니다(Windows 11 기본 포함).

## 개발 / 빌드

```powershell
npm install
npm run tauri dev      # 개발 모드
npm run tauri build    # 릴리스 exe + NSIS 설치 프로그램
powershell -ExecutionPolicy Bypass -File scripts\build-msix.ps1   # Microsoft Store용 MSIX (dist-msix\)
cd src-tauri; cargo test   # 스캐너 단위 테스트
```

필요 도구: Node 20+, Rust(stable, MSVC), Visual Studio Build Tools(C++), Windows SDK.

## 구조

| 경로 | 역할 |
|---|---|
| `src-tauri/src/scanner.rs` | 병렬 스캐너, 트리 집계(`Node`), 뷰 스냅샷, Top-N, 검색, AI 컨텍스트 |
| `src-tauri/src/cleaner.rs` | 탐색기 열기, 휴지통 이동, 화이트리스트 정리 명령, Safe Cache 정리 |
| `src-tauri/src/llm.rs` | Ollama / OpenAI 호환 / Claude 호출 |
| `src-tauri/src/settings.rs` | 설정 저장 (API 키는 DPAPI 암호화) |
| `src-tauri/src/main.rs` | Tauri 커맨드, 200ms 주기 `scan-progress` 이벤트 |
| `src/lib/treemap.ts` | Squarified Treemap 순수 함수, 중첩 레이아웃 |
| `src/components/TreemapCanvas.tsx` | Canvas 렌더러, 호버/클릭/더블클릭 줌 |
| `src/services/storageAdvisor.ts` | 경로 안전도 룰 엔진, 카테고리 분류, LLM 프롬프트 빌더 |
| `src/components/AiAdvisorPanel.tsx` | 인스펙터, 분석 리포트, 채팅 |
| `src/store.ts` | Zustand 전역 상태 |

## 동작 방식 메모

- **스캔**: 디렉토리 핸들당 `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)`로 대량 열거해 파일을 개별적으로 열지 않고 논리 크기·할당 크기·File ID를 얻습니다. 지원하지 않는 파일시스템은 `FindFirstFileExW`로 폴백합니다.
- **중복 집계 방지**: Reparse Point(정션/심볼릭 링크)는 따라가지 않고, 같은 File ID를 다시 만나면 하드링크로 보고 크기를 0으로 집계합니다.
- **스트리밍**: 전체 트리는 Rust가 보유하고, 프론트엔드에는 현재 보기 기준으로 가지치기한 스냅샷만 200ms마다 보냅니다.
- **안전장치**: 정리 명령은 사전 정의된 ID만 실행합니다(LLM이 제안한 임의 명령은 복사만 가능). 휴지통 이동은 UI와 백엔드 양쪽에서 OS 핵심 경로를 거부합니다. Safe Cache 정리 경로는 백엔드 내장 목록에서만 가져옵니다.
- **MFT 직접 파싱**은 구현되어 있지 않습니다. 열거 계층(`enumerate_dir` → `RawEntry`)이 집계와 분리되어 있어 같은 인터페이스로 추가할 수 있습니다.
