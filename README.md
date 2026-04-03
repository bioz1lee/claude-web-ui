# Claude Code Web UI

Claude Code CLI를 브라우저에서 쓸 수 있는 로컬 전용 웹 UI입니다.  
외부 서버 없이 내 컴퓨터에서만 실행됩니다 (127.0.0.1:8321).

![Python](https://img.shields.io/badge/Python-3.8%2B-blue) ![No dependencies](https://img.shields.io/badge/dependencies-none-green)

---

## 주요 기능

- **대화 히스토리** — 세션별 자동 저장, 날짜 그룹화, 검색
- **파일 첨부** — 이미지, PDF, 코드 파일 최대 200MB
- **북마크** — 중요한 응답 저장
- **모델 선택** — Opus / Sonnet / Haiku
- **시스템 프롬프트** — 매 대화에 자동 적용
- **작업 디렉토리 설정** — Claude가 읽고 쓸 기본 경로 지정
- **응답 중단** — 생성 중 언제든 중지 가능

---

## 사전 요구사항

- **Python 3.8+** — 별도 패키지 설치 불필요 (표준 라이브러리만 사용)
- **Claude Code CLI** 설치 및 로그인 완료

Claude Code CLI 설치 방법:
```bash
npm install -g @anthropic-ai/claude-code
claude login
```

---

## 설치 및 실행

### 1. 저장소 클론

```bash
git clone https://github.com/YOUR_USERNAME/claude-web-ui.git
cd claude-web-ui
```

### 2. 서버 실행

**macOS (더블클릭으로 실행):**
```
start.command 파일을 더블클릭
```
처음 실행 시 "확인되지 않은 개발자" 경고가 뜨면:  
시스템 설정 → 개인 정보 보호 및 보안 → "확인 없이 열기" 클릭

**터미널에서 직접 실행 (모든 OS):**
```bash
python3 server.py
```

### 3. 브라우저에서 접속

```
http://127.0.0.1:8321
```

서버를 중지하려면 터미널에서 `Ctrl+C`.

---

## 사용법

1. **새 대화 시작** — 하단 입력창에 메시지 입력 후 Enter 또는 전송 버튼
2. **파일 첨부** — 입력창 옆 클립 아이콘 클릭, 또는 파일을 드래그 앤 드롭
3. **설정** — 우상단 ⚙️ 아이콘에서 시스템 프롬프트, 작업 디렉토리, 모델 변경
4. **북마크** — 응답 hover 시 나타나는 북마크 아이콘 클릭
5. **대화 삭제** — 사이드바에서 대화 항목 우클릭

---

## 데이터 저장 위치

모든 데이터는 로컬에만 저장됩니다:

| 파일/폴더 | 내용 |
|---|---|
| `conversations.json` | 대화 목록 |
| `history/*.json` | 대화별 메시지 |
| `bookmarks.json` | 북마크 |
| `uploads/` | 첨부 파일 |

---

## 포트 변경

기본 포트는 8321입니다. 변경하려면 `server.py` 상단의 `PORT` 값을 수정하세요:

```python
PORT = 8321  # 원하는 포트 번호로 변경
```

---

## 라이선스

MIT
