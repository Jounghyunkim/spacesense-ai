# Microsoft Store 등록 정보 — SpaceSense AI

Partner Center 제출 화면의 항목 순서대로 정리했습니다. `<...>` 표시는 직접 채워야 하는 값입니다.

- 업로드할 패키지: `dist-msix\SpaceSenseAI_1.0.0.0_x64.msix` (서명 불필요 — Store가 서명)
- Store ID: `9P45XZZ6T971` / 패키지 ID: `JohnnyStudio.SpaceSenseAI`

---

## 1. 가격 및 가용성

| 항목 | 값 |
|---|---|
| 시장 | 모든 시장 (UI가 한국어뿐이므로 한국만 선택해도 무방) |
| 대상 | 공개 |
| 가격 | 무료 |
| 무료 평가판 | 해당 없음 |

## 2. 속성

| 항목 | 값 |
|---|---|
| 범주 | 유틸리티 및 도구 |
| 하위 범주 | 파일 관리자 |
| 개인정보처리방침 URL | `<PRIVACY.md를 게시한 URL>` — 필수 (AI 분석 시 경로 정보가 외부로 전송될 수 있으므로) |
| 웹 사이트 | `<선택>` |
| 지원 연락처 | `<지원용 이메일 또는 URL>` |
| 제품이 개인 정보에 접근·수집·전송합니까? | 예 |

**시스템 요구 사항**

| | 최소 | 권장 |
|---|---|---|
| OS | Windows 10 버전 1809 (x64) | Windows 11 (x64) |
| 메모리 | 4 GB | 8 GB |
| 기타 | Microsoft Edge WebView2 런타임 | AI 기능: Ollama 로컬 설치 또는 OpenAI 호환 / Anthropic API 키 |

## 3. 연령 등급 (IARC 설문)

- 앱 유형: **유틸리티 / 생산성**
- 폭력·성적 내용·약물·도박·욕설: 모두 **아니요**
- 사용자 간 소통/콘텐츠 공유: **아니요**
- 위치 공유: **아니요**, 디지털 구매: **아니요**
- 예상 결과: 전체 이용가 (IARC 3+)

## 4. 패키지

- `SpaceSenseAI_1.0.0.0_x64.msix` 업로드
- 디바이스 패밀리: Windows 10/11 Desktop 만 선택

## 5. Store 목록 — 한국어 (ko-KR)

### 제품 이름

```
SpaceSense AI
```

> 매니페스트의 DisplayName(`SpaceSense AI`)과 Partner Center에서 예약한 이름이 **정확히 일치**해야 합니다. 다른 이름으로 예약했다면 `msix\AppxManifest.xml`의 DisplayName 두 곳을 바꾸고 다시 빌드하세요.

### 짧은 설명

```
디스크를 무엇이 차지하고 있는지 실시간 트리맵으로 한눈에 보고, AI 어드바이저의 설명과 함께 안전하게 정리하세요.
```

### 설명

```
SpaceSense AI는 Windows용 디스크 공간 분석·정리 도구입니다. 드라이브나 폴더를 스캔하면 용량을 차지하는 폴더와 파일이 트리맵으로 실시간 표시되고, AI Storage Advisor가 "이 폴더가 무엇인지, 지워도 되는지"를 설명해 줍니다.

■ 실시간 트리맵
• 스캔이 진행되는 동안 트리맵이 바로바로 채워집니다. 끝날 때까지 기다릴 필요가 없습니다.
• 클릭으로 선택하고, 더블클릭으로 폴더 안으로 들어가며, 표시 깊이를 조절할 수 있습니다.
• 파일 크기와 디스크 할당 크기 중 원하는 기준으로 볼 수 있습니다.

■ 빠르고 정확한 스캔
• 다중 스레드 병렬 스캐너가 대용량 드라이브도 빠르게 훑습니다.
• 하드링크는 한 번만 집계하고 정션·심볼릭 링크는 따라가지 않아 용량이 중복 계산되지 않습니다.
• 가장 큰 파일 목록과 이름 검색으로 원하는 항목을 바로 찾습니다.

■ AI Storage Advisor
• 선택한 폴더·파일의 정체와 삭제 안전도를 규칙 엔진이 즉시 분류합니다.
• 스캔 결과를 바탕으로 공간 확보 리포트를 받고, 채팅으로 추가 질문을 할 수 있습니다.
• AI 제공자를 직접 선택합니다: 내 PC에서 동작하는 Ollama(로컬), OpenAI 호환 API, Anthropic Claude.
• API 키는 Windows DPAPI로 암호화되어 내 PC에만 저장됩니다.

■ 안전한 정리
• 원클릭 캐시 정리: 임시 파일, 크래시 덤프, DirectX 셰이더 캐시, 브라우저 캐시(Chrome/Edge), pip·uv·npm·Yarn·NuGet·Gradle·Cargo 캐시 등을 항목별로 크기를 확인한 뒤 선택해 정리합니다.
• 일반 삭제는 휴지통으로 이동하므로 되돌릴 수 있습니다.
• Windows, Program Files, 사용자 프로필 같은 OS 핵심 경로는 삭제가 차단됩니다.
• 시스템 정리 명령(디스크 정리, 구성 요소 정리, 저장소 설정 열기 등)은 미리 정의된 목록만 실행되며, AI가 제안한 임의의 명령은 자동 실행되지 않고 복사만 가능합니다.

■ 개인정보
• 계정이 필요 없고, 광고나 사용 통계 수집이 없습니다.
• 스캔 결과는 PC를 떠나지 않습니다. AI 분석을 직접 실행할 때에만 폴더·파일 경로와 크기 요약이 사용자가 선택한 AI 제공자로 전송됩니다. Ollama를 쓰면 모든 처리가 PC 안에서 이루어집니다.

참고
• 시스템 폴더까지 모두 스캔하거나 일부 시스템 캐시를 정리하려면 앱 안에서 "관리자 권한으로 다시 시작"을 선택하세요.
• AI 기능을 쓰려면 Ollama 설치 또는 본인의 API 키가 필요합니다. API 사용료는 각 제공자 정책에 따릅니다. AI 없이도 스캔·트리맵·정리 기능은 모두 동작합니다.
• AI의 답변은 참고용이며, 삭제 전 항목을 직접 확인하세요.
```

### 이 버전의 새로운 기능

```
SpaceSense AI 첫 출시 버전입니다.
```

### 제품 기능 (항목당 1줄)

```
스캔 중에도 실시간으로 갱신되는 트리맵
다중 스레드 고속 병렬 스캔
하드링크·정션 중복 집계 방지로 정확한 용량 표시
가장 큰 파일 목록과 이름 검색
AI Storage Advisor: 폴더 설명, 정리 리포트, 채팅
Ollama(로컬) · OpenAI 호환 API · Anthropic Claude 지원
원클릭 안전 캐시 정리 (임시 파일, 브라우저·개발 도구 캐시)
휴지통 이동 방식의 삭제와 OS 핵심 경로 보호
API 키 DPAPI 암호화 저장, 사용 통계 수집 없음
```

### 검색어 (최대 7개)

```
디스크 정리
디스크 용량 분석
트리맵
저장 공간 확보
캐시 정리
disk space analyzer
AI 정리
```

### 저작권 및 상표 정보

```
© 2026 JohnnyStudio
```

### 스크린샷 (직접 촬영 필요 — 최소 1장, 4장 이상 권장, 1366×768 이상 PNG)

개인 폴더 이름이 드러나지 않는 폴더를 스캔해서 촬영하세요.

1. 드라이브 스캔 완료 후의 전체 트리맵 — 캡션: `디스크를 채운 것이 무엇인지 한눈에`
2. 스캔 진행 중 화면(진행 상태 표시) — 캡션: `스캔하는 동안 실시간으로 채워지는 트리맵`
3. AI Advisor 패널의 분석 리포트 — 캡션: `AI가 설명해 주는 공간 확보 방법`
4. 원클릭 캐시 정리 대화상자 — 캡션: `항목별로 확인하고 안전하게 정리`
5. 가장 큰 파일 목록 / 검색 — 캡션: `가장 큰 파일을 바로 찾기`

Store 로고(선택): `app-icon.png`를 300×300 으로 줄여 사용할 수 있습니다.

## 6. Store 목록 — English (en-US, 선택)

앱 UI는 한국어이므로 영어 목록을 추가한다면 설명 마지막 줄의 안내 문구를 유지하세요.

### Short description

```
See what is filling your disk on a live treemap, and clean it up safely with explanations from an AI storage advisor.
```

### Description

```
SpaceSense AI is a disk space analyzer and cleanup tool for Windows. Scan a drive or folder and watch a treemap fill in as the scan runs, then let the AI Storage Advisor explain what each folder is and whether it is safe to remove.

Live treemap
• The treemap updates while the scan is still running.
• Click to select, double-click to drill into a folder, and adjust the visible depth.
• Switch between file size and size on disk.

Fast, accurate scanning
• A multi-threaded scanner handles large drives quickly.
• Hard links are counted once and junctions/symlinks are not followed, so sizes are not double-counted.
• Largest-files list and name search.

AI Storage Advisor
• A built-in rule engine classifies folders and their deletion safety instantly.
• Get a cleanup report based on your scan and ask follow-up questions in chat.
• Choose your provider: Ollama (runs locally), any OpenAI-compatible API, or Anthropic Claude.
• API keys are encrypted with Windows DPAPI and stored only on your PC.

Safe cleanup
• One-click cache cleanup for temp files, crash dumps, shader cache, Chrome/Edge cache, and pip, uv, npm, Yarn, NuGet, Gradle and Cargo caches. Review sizes and pick what to clean.
• Deleting sends items to the Recycle Bin.
• Core OS locations such as Windows, Program Files and your user profile are blocked from deletion.
• System cleanup commands run only from a predefined list. Commands suggested by the AI are never run automatically.

Privacy
• No account, no ads, no usage tracking.
• Scan results stay on your PC. Folder and file paths and sizes are sent to the AI provider you chose only when you run an AI analysis. With Ollama, everything stays local.

Notes
• The app interface is currently in Korean.
• AI features require Ollama or your own API key; provider fees may apply. Scanning, the treemap and cleanup work without AI.
• To scan protected system folders, choose "Restart as administrator" inside the app.
```

### Search terms

```
disk space analyzer
treemap
disk cleanup
storage cleaner
free up space
folder size
AI storage advisor
```

## 7. 제출 옵션

### 제한된 접근 권한(Restricted capabilities) 사용 근거 — 영어로 입력

**runFullTrust**

```
SpaceSense AI is a Win32 desktop application (Rust + WebView2, built with Tauri) packaged as MSIX. It needs full trust to enumerate files and folders across the user's drives with Win32 file APIs in order to measure disk usage, to move user-selected items to the Recycle Bin, and to launch built-in Windows tools (Disk Cleanup, Storage settings, File Explorer).
```

**allowElevation**

```
Some system folders and cleanup targets (for example C:\Windows\Temp, the Windows Update download cache, and "dism /online /cleanup-image /startcomponentcleanup") require administrator rights. The app runs as a standard user by default and requests elevation through a UAC prompt only when the user explicitly clicks "Restart as administrator" or chooses one of those predefined cleanup commands. Elevation is never requested silently or at startup.
```

### 인증 참고 사항 (Notes for certification) — 영어로 입력

```
- The app UI is in Korean.
- No account or sign-in is required. Core features can be tested without any setup: launch the app, pick a drive or folder at the top, and the treemap fills in while the scan runs.
- The AI advisor panel on the right is optional. It needs either a local Ollama server (http://localhost:11434) or a user-supplied API key for an OpenAI-compatible service or Anthropic. Without one, the AI request shows a connection error; all other features continue to work.
- File and folder paths/sizes are sent to the selected AI provider only when the user starts an AI analysis or chat. Nothing else is transmitted; there is no telemetry.
- Deleting items moves them to the Recycle Bin. Core OS paths are blocked. The cache cleanup dialog lists each target and its size, and only runs after the user confirms the selection.
- Elevation (UAC) is requested only when the user clicks "Restart as administrator" or runs an admin-only cleanup command.
- Requires the Microsoft Edge WebView2 Runtime (included with Windows 11 and current Windows 10).
```

## 8. 제출 전 확인

- [ ] 예약한 제품 이름 = 매니페스트 DisplayName (`SpaceSense AI`)
- [ ] `PRIVACY.md`를 공개 URL에 게시하고 연락처를 채운 뒤 URL 입력
- [ ] 스크린샷 촬영
- [ ] (권장) 개발자 모드를 켠 PC에서 패키지 설치 테스트 — 아래 참고

### 로컬 설치 테스트

Store용 패키지는 서명이 없어 더블클릭으로 설치되지 않습니다. 개발자 모드(설정 > 시스템 > 개발자용)를 켠 뒤 다음으로 등록해 테스트하세요.

```powershell
Add-AppxPackage -Register src-tauri\target\msix\layout\AppxManifest.xml
# 테스트 후 제거
Get-AppxPackage JohnnyStudio.SpaceSenseAI | Remove-AppxPackage
```

패키지 상태에서 꼭 확인할 항목: ① 설정 저장/불러오기 ② 캐시 정리로 실제 용량이 줄어드는지 ③ "관리자 권한으로 다시 시작" 동작.
