#!/usr/bin/env python3
"""Local-only interactive Claude Code web UI. No external dependencies."""

import http.server
import json
import subprocess
import threading
import os
import signal
import sys
import uuid
import mimetypes
import io
import datetime
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

PORT = 8321
HOST = "127.0.0.1"

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
MAX_UPLOAD_SIZE = 200 * 1024 * 1024  # 200MB

ALLOWED_MIME_PREFIXES = ("image/", "text/", "application/pdf", "application/json")
CONVERSATIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "conversations.json")
HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history")
BOOKMARKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookmarks.json")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(HISTORY_DIR, exist_ok=True)

# Track running processes for abort support
active_procs = {}  # session_id -> subprocess.Popen
active_procs_lock = threading.Lock()

# Paper search cache: key -> {"ts": float, "data": dict}
_paper_cache = {}
_PAPER_CACHE_TTL = 300  # 5 minutes

# Known predatory publishers to exclude from results
_PREDATORY_PUBLISHERS = frozenset([
    "omics group", "omics international", "omics publishing group",
    "scientific research publishing", "scirp",
    "iomcworld", "waset",
    "world academy of science engineering and technology",
])

# High-impact journal tier list (55 journals, key=lowercase)
_JOURNAL_TIER = {
    # Tier 1 — CNS
    "nature": 1, "science": 1, "cell": 1,
    # Tier 2 — Nature family
    "nature medicine": 2, "nature genetics": 2, "nature methods": 2,
    "nature biotechnology": 2, "nature cell biology": 2, "nature neuroscience": 2,
    "nature immunology": 2, "nature chemical biology": 2,
    "nature structural & molecular biology": 2, "nature structural and molecular biology": 2,
    "nature communications": 2, "nature reviews genetics": 2,
    "nature reviews molecular cell biology": 2, "nature microbiology": 2, "nature metabolism": 2,
    # Tier 2 — Cell family
    "molecular cell": 2, "cell stem cell": 2, "developmental cell": 2,
    "cell reports": 2, "cell host & microbe": 2, "cell host and microbe": 2,
    "cell systems": 2, "cell metabolism": 2,
    # Tier 2 — Science family
    "science advances": 2, "science translational medicine": 2,
    "science immunology": 2, "science signaling": 2,
    # Tier 2 — Top medical
    "the new england journal of medicine": 2, "new england journal of medicine": 2,
    "the lancet": 2, "lancet": 2, "jama": 2, "bmj": 2, "bmj (clinical research ed.)": 2,
    # Tier 3 — Top life sciences
    "proceedings of the national academy of sciences of the united states of america": 3,
    "proc natl acad sci u s a": 3, "pnas": 3,
    "the embo journal": 3, "embo journal": 3, "elife": 3,
    "genome research": 3, "genome biology": 3, "nucleic acids research": 3,
    "bioinformatics": 3, "plos biology": 3, "current biology": 3,
    "annual review of biochemistry": 3, "annual review of cell and developmental biology": 3,
    "annual review of genetics": 3, "annual review of genomics and human genetics": 3,
    "molecular biology and evolution": 3, "trends in biochemical sciences": 3,
    "trends in cell biology": 3, "trends in genetics": 3,
    "molecular systems biology": 3, "plos genetics": 3, "bmc biology": 3,
    "journal of clinical investigation": 3, "the journal of clinical investigation": 3,
    "nature protocols": 3, "briefings in bioinformatics": 3, "genome medicine": 3,
}
_DEFAULT_TIER = 99

# Lock for conversations.json read/write
conversations_lock = threading.Lock()


class ChatHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        routes = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/style.css": ("style.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "application/javascript; charset=utf-8"),
        }
        if path in routes:
            self._serve_file(*routes[path])
        elif path.startswith("/uploads/"):
            self._serve_upload(path)
        elif path == "/api/local":
            self._handle_local_file()
        elif path == "/api/conversations":
            self._handle_get_conversations()
        elif path.startswith("/api/conversations/") and path.endswith("/messages"):
            sid = path.split("/api/conversations/")[1].rsplit("/messages", 1)[0]
            self._handle_get_messages(sid)
        elif path == "/api/bookmarks":
            self._handle_get_bookmarks()
        elif path == "/api/paper-search":
            self._handle_paper_search()
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/api/bookmarks/"):
            bid = self.path.split("/api/bookmarks/")[1]
            self._handle_delete_bookmark(bid)
        elif self.path.startswith("/api/conversations/"):
            sid = self.path.split("/api/conversations/")[1]
            self._handle_delete_conversation(sid)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/api/chat":
            self._handle_chat()
        elif self.path == "/api/upload":
            self._handle_upload()
        elif self.path == "/api/abort":
            self._handle_abort()
        elif self.path.startswith("/api/conversations/") and self.path.endswith("/messages"):
            sid = self.path.split("/api/conversations/")[1].rsplit("/messages", 1)[0]
            self._handle_save_message(sid)
        elif self.path == "/api/bookmarks":
            self._handle_save_bookmark()
        else:
            self.send_error(404)

    def _serve_file(self, filename, content_type):
        filepath = os.path.join(STATIC_DIR, filename)
        try:
            with open(filepath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(data))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404)

    def _serve_upload(self, path):
        """Serve uploaded files from the uploads directory."""
        # Sanitize: only allow the filename part, prevent directory traversal
        filename = os.path.basename(path)
        filepath = os.path.join(UPLOAD_DIR, filename)
        if not os.path.isfile(filepath):
            self.send_error(404)
            return
        content_type, _ = mimetypes.guess_type(filepath)
        if not content_type:
            content_type = "application/octet-stream"
        try:
            with open(filepath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(data))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404)

    def _handle_local_file(self):
        """Serve a local file by absolute path (localhost only — no auth needed)."""
        from urllib.parse import urlparse, parse_qs, unquote
        params = parse_qs(urlparse(self.path).query)
        file_path = params.get("path", [None])[0]
        if not file_path:
            self.send_error(400)
            return
        file_path = unquote(file_path)
        if not os.path.isfile(file_path):
            self.send_error(404)
            return
        content_type, _ = mimetypes.guess_type(file_path)
        if not content_type:
            content_type = "application/octet-stream"
        try:
            with open(file_path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(data))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            self.send_error(500)

    def _handle_upload(self):
        """Handle multipart/form-data file upload."""
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_json_error(400, "Content-Type must be multipart/form-data")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > MAX_UPLOAD_SIZE:
            self._send_json_error(413, f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024*1024)}MB")
            return

        # Parse the multipart boundary
        boundary = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):]
                break

        if not boundary:
            self._send_json_error(400, "Missing boundary in Content-Type")
            return

        # Read the entire body
        body = self.rfile.read(content_length)

        # Parse multipart data manually
        file_data, filename, file_content_type = self._parse_multipart(body, boundary)

        if file_data is None:
            self._send_json_error(400, "No file found in request")
            return

        if len(file_data) > MAX_UPLOAD_SIZE:
            self._send_json_error(413, f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024*1024)}MB")
            return

        # Validate MIME type
        if not file_content_type:
            file_content_type, _ = mimetypes.guess_type(filename)
        if not file_content_type:
            file_content_type = "application/octet-stream"

        # Generate unique filename to avoid collisions
        ext = os.path.splitext(filename)[1] if filename else ""
        safe_name = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(UPLOAD_DIR, safe_name)

        with open(save_path, "wb") as f:
            f.write(file_data)

        # Return JSON response
        response = {
            "file_path": save_path,
            "filename": filename,
            "type": file_content_type,
            "url": f"/uploads/{safe_name}",
            "size": len(file_data),
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp_body = json.dumps(response, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp_body))
        self.end_headers()
        self.wfile.write(resp_body)

    def _parse_multipart(self, body, boundary):
        """Parse multipart/form-data body. Returns (file_data, filename, content_type) or (None, None, None)."""
        boundary_bytes = f"--{boundary}".encode()
        parts = body.split(boundary_bytes)

        for part in parts:
            if not part or part == b"--\r\n" or part == b"--":
                continue

            # Split headers from body
            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue

            header_section = part[:header_end].decode("utf-8", errors="replace")
            file_body = part[header_end + 4:]  # skip \r\n\r\n

            # Remove trailing \r\n
            if file_body.endswith(b"\r\n"):
                file_body = file_body[:-2]

            # Parse headers
            filename = None
            content_type = None
            is_file = False

            for line in header_section.split("\r\n"):
                lower = line.lower()
                if "content-disposition:" in lower and "filename=" in lower:
                    is_file = True
                    # Extract filename
                    for param in line.split(";"):
                        param = param.strip()
                        if param.startswith("filename="):
                            filename = param[len("filename="):].strip('"').strip("'")
                if lower.startswith("content-type:"):
                    content_type = line.split(":", 1)[1].strip()

            if is_file and filename:
                return file_body, filename, content_type

        return None, None, None

    @staticmethod
    def _load_conversations():
        if os.path.isfile(CONVERSATIONS_FILE):
            with open(CONVERSATIONS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return []

    @staticmethod
    def _save_conversations(convos):
        with open(CONVERSATIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(convos, f, ensure_ascii=False, indent=2)

    @staticmethod
    def _upsert_conversation(session_id, title=None):
        import datetime
        with conversations_lock:
            convos = ChatHandler._load_conversations()
            now = datetime.datetime.now().isoformat()
            for c in convos:
                if c["session_id"] == session_id:
                    c["updated_at"] = now
                    if title and c.get("title", "").startswith("새 대화"):
                        c["title"] = title
                    ChatHandler._save_conversations(convos)
                    return
            convos.insert(0, {
                "session_id": session_id,
                "title": title or "새 대화",
                "created_at": now,
                "updated_at": now,
            })
            ChatHandler._save_conversations(convos)

    @staticmethod
    def _update_conversation_title(session_id, title):
        with conversations_lock:
            convos = ChatHandler._load_conversations()
            for c in convos:
                if c["session_id"] == session_id:
                    c["title"] = title
                    ChatHandler._save_conversations(convos)
                    return

    WIKI_DIR = os.path.join(os.path.expanduser("~"), "Documents", "Obsidian Vault", "Wiki")

    @staticmethod
    def _update_wiki_async(assistant_response, sse_writer):
        """Background thread: update LLM-Wiki from paper study results."""
        wiki_dir = ChatHandler.WIKI_DIR
        topics_dir = os.path.join(wiki_dir, "topics")
        index_path = os.path.join(wiki_dir, "index.md")
        if not os.path.isdir(topics_dir):
            return
        try:
            # Read existing topics for context
            existing_topics = []
            for f in os.listdir(topics_dir):
                if f.endswith(".md"):
                    existing_topics.append(f)

            prompt = (
                "아래는 Paper Study로 분석한 논문 내용이야. "
                "이 내용을 바탕으로 Obsidian Wiki를 업데이트해줘.\n\n"
                "## 규칙\n"
                f"- 위키 토픽 폴더: {topics_dir}\n"
                f"- 위키 인덱스: {index_path}\n"
                f"- 기존 토픽 파일들: {', '.join(existing_topics) if existing_topics else '없음'}\n"
                "- 기존 토픽이 있으면 내용을 병합 (중복 금지). 기존 파일을 먼저 읽고 업데이트.\n"
                "- 새 토픽이 필요하면 생성\n"
                "- 각 토픽 문서의 sources 필드와 본문 하단에 출처 논문을 [[링크]]로 표시\n"
                "- index.md의 Topics 섹션과 '통합된 논문' 목록도 갱신\n"
                "- 토픽 파일명은 kebab-case (예: single-cell-rna-seq.md)\n"
                "- frontmatter에 title, tags, updated (오늘 날짜), sources 포함\n"
                "- 한국어로 작성\n\n"
                "## 논문 분석 내용\n\n"
                f"{assistant_response[:15000]}"
            )
            result = subprocess.run(
                ["claude", "-p", "--dangerously-skip-permissions",
                 "--model", "claude-sonnet-4-6", "--max-turns", "5"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=os.path.expanduser("~"),
            )
            if result.returncode == 0:
                try:
                    sse_writer({"type": "text", "text": "\n\n---\n> Wiki 자동 업데이트 완료"})
                except Exception:
                    pass
        except Exception:
            pass  # Wiki update is best-effort

    @staticmethod
    def _generate_title_async(session_id, user_message, assistant_response, sse_writer):
        """Background thread: generate a smart title using Claude Haiku."""
        try:
            prompt = (
                "아래 대화를 보고, 이 대화의 핵심 주제를 한국어로 30자 이내의 짧은 제목 한 줄로 요약해줘. "
                "제목만 출력하고 다른 설명은 붙이지 마.\n\n"
                f"사용자: {user_message[:500]}\n\n"
                f"응답: {assistant_response[:500]}"
            )
            result = subprocess.run(
                ["claude", "-p", "--model", "claude-haiku-4-5-20251001", "--max-turns", "1"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=15,
            )
            title = result.stdout.strip()
            if title and len(title) <= 60:
                ChatHandler._update_conversation_title(session_id, title)
                try:
                    sse_writer({"type": "title_update", "session_id": session_id, "title": title})
                except Exception:
                    pass  # SSE connection may already be closed
        except Exception:
            pass  # Title generation is best-effort

    def _handle_get_conversations(self):
        with conversations_lock:
            convos = self._load_conversations()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps(convos, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _handle_delete_conversation(self, session_id):
        with conversations_lock:
            convos = self._load_conversations()
            convos = [c for c in convos if c["session_id"] != session_id]
            self._save_conversations(convos)
        # Also delete history file
        hfile = os.path.join(HISTORY_DIR, f"{session_id}.json")
        if os.path.isfile(hfile):
            os.remove(hfile)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = b'{"deleted":true}'
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    # --- Message history ---
    def _handle_get_messages(self, session_id):
        filepath = os.path.join(HISTORY_DIR, f"{session_id}.json")
        messages = []
        if os.path.isfile(filepath):
            with open(filepath, "r", encoding="utf-8") as f:
                messages = json.load(f)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps(messages, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _handle_save_message(self, session_id):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        msg = json.loads(body) if body else {}
        filepath = os.path.join(HISTORY_DIR, f"{session_id}.json")
        messages = []
        if os.path.isfile(filepath):
            with open(filepath, "r", encoding="utf-8") as f:
                messages = json.load(f)
        messages.append(msg)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(messages, f, ensure_ascii=False, indent=2)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = b'{"saved":true}'
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    # --- Bookmarks ---
    @staticmethod
    def _load_bookmarks():
        if os.path.isfile(BOOKMARKS_FILE):
            with open(BOOKMARKS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return []

    @staticmethod
    def _save_bookmarks_file(bookmarks):
        with open(BOOKMARKS_FILE, "w", encoding="utf-8") as f:
            json.dump(bookmarks, f, ensure_ascii=False, indent=2)

    def _handle_get_bookmarks(self):
        bookmarks = self._load_bookmarks()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps(bookmarks, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _handle_save_bookmark(self):
        import datetime
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body) if body else {}
        bookmark = {
            "id": uuid.uuid4().hex[:12],
            "session_id": data.get("session_id", ""),
            "title": data.get("title", ""),
            "content": data.get("content", ""),
            "created_at": datetime.datetime.now().isoformat(),
        }
        if data.get("pdfUrl"):
            bookmark["pdfUrl"] = data["pdfUrl"]
        bookmarks = self._load_bookmarks()
        bookmarks.insert(0, bookmark)
        self._save_bookmarks_file(bookmarks)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps(bookmark, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)
        # Generate AI title for bookmark in background
        threading.Thread(
            target=self._generate_bookmark_title_async,
            args=(bookmark["id"], bookmark["content"]),
            daemon=True,
        ).start()

    @staticmethod
    def _generate_bookmark_title_async(bookmark_id, content):
        """Background thread: generate a smart bookmark title using Claude Haiku."""
        try:
            prompt = (
                "아래 AI 응답의 핵심 내용을 한국어로 30자 이내의 짧은 제목 한 줄로 요약해줘. "
                "제목만 출력하고 다른 설명은 붙이지 마.\n\n"
                f"{content[:800]}"
            )
            result = subprocess.run(
                ["claude", "-p", "--model", "claude-haiku-4-5-20251001", "--max-turns", "1"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=15,
            )
            title = result.stdout.strip()
            if title and len(title) <= 60:
                bookmarks = ChatHandler._load_bookmarks()
                for b in bookmarks:
                    if b["id"] == bookmark_id:
                        b["title"] = title
                        ChatHandler._save_bookmarks_file(bookmarks)
                        break
        except Exception:
            pass  # Best-effort

    def _handle_delete_bookmark(self, bookmark_id):
        bookmarks = self._load_bookmarks()
        bookmarks = [b for b in bookmarks if b["id"] != bookmark_id]
        self._save_bookmarks_file(bookmarks)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = b'{"deleted":true}'
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _handle_abort(self):
        """Abort the running Claude process for a session."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body) if body else {}
        sid = data.get("session_id", "")
        killed = False
        with active_procs_lock:
            proc = active_procs.pop(sid, None)
            if proc and proc.poll() is None:
                proc.terminate()
                killed = True
        resp = {"aborted": killed}
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp_body = json.dumps(resp).encode("utf-8")
        self.send_header("Content-Length", len(resp_body))
        self.end_headers()
        self.wfile.write(resp_body)

    def _send_json(self, data, code=200):
        """Send a JSON response."""
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _handle_paper_search(self):
        """Search PubMed and enrich with Crossref citation counts."""
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        q = params.get("q", [None])[0]
        if not q or not q.strip():
            self._send_json_error(400, "검색어를 입력해주세요")
            return

        q = q.strip()
        max_results = min(int(params.get("max", ["10"])[0]), 50)
        sort_by = params.get("sort", ["relevance"])[0]
        if sort_by not in ("relevance", "date", "citations", "journal"):
            sort_by = "relevance"
        years = params.get("years", ["all"])[0]
        if years not in ("all", "3", "5", "10"):
            years = "all"
        review = params.get("review", ["0"])[0]
        if review not in ("0", "1"):
            review = "0"
        cache_key = f"{q}|{max_results}|{sort_by}|{years}|{review}"

        cached = _paper_cache.get(cache_key)
        if cached and (time.time() - cached["ts"] < _PAPER_CACHE_TTL):
            self._send_json(cached["data"])
            return

        try:
            ncbi_key = os.environ.get("NCBI_API_KEY", "")

            # Step 1: esearch — get PMID list
            search_term = q
            if review == "1":
                search_term = f"{q} AND Review[pt]"
            search_params = {"db": "pubmed", "term": search_term, "retmax": str(max_results), "retmode": "json"}
            if sort_by == "date":
                search_params["sort"] = "date"
            if years != "all":
                current_year = datetime.date.today().year
                min_year = current_year - int(years)
                search_params["datetype"] = "pdat"
                search_params["mindate"] = f"{min_year}/01/01"
                search_params["maxdate"] = f"{current_year}/12/31"
            if ncbi_key:
                search_params["api_key"] = ncbi_key
            search_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?" + urllib.parse.urlencode(search_params)
            req = urllib.request.Request(search_url, headers={"User-Agent": "claude-web-ui/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                search_data = json.loads(resp.read().decode("utf-8"))

            pmids = search_data.get("esearchresult", {}).get("idlist", [])
            if not pmids:
                result = {"query": q, "total": 0, "papers": []}
                _paper_cache[cache_key] = {"ts": time.time(), "data": result}
                self._send_json(result)
                return

            # Step 2: efetch — get full metadata as XML
            time.sleep(0.35)  # respect 3 req/s rate limit
            fetch_params = {"db": "pubmed", "id": ",".join(pmids), "retmode": "xml", "rettype": "abstract"}
            if ncbi_key:
                fetch_params["api_key"] = ncbi_key
            fetch_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?" + urllib.parse.urlencode(fetch_params)
            req2 = urllib.request.Request(fetch_url, headers={"User-Agent": "claude-web-ui/1.0"})
            with urllib.request.urlopen(req2, timeout=20) as resp2:
                xml_data = resp2.read().decode("utf-8")

            # Step 3: parse XML
            root = ET.fromstring(xml_data)
            papers = []
            for article in root.findall(".//PubmedArticle"):
                medline = article.find("MedlineCitation")
                if medline is None:
                    continue
                art = medline.find("Article")
                if art is None:
                    continue

                title_el = art.find("ArticleTitle")
                title = "".join(title_el.itertext()).strip() if title_el is not None else ""

                journal = art.findtext("Journal/Title", "")
                year = (art.findtext("Journal/JournalIssue/PubDate/Year") or
                        art.findtext("Journal/JournalIssue/PubDate/MedlineDate", "")[:4])

                # Authors + first-author affiliation
                authors = []
                affiliation = ""
                for i, author in enumerate(art.findall("AuthorList/Author")):
                    last = author.findtext("LastName", "")
                    fore = author.findtext("ForeName", "")
                    if last:
                        initials = f" {fore[0]}." if fore else ""
                        authors.append(f"{last}{initials}")
                    if i == 0 and not affiliation:
                        aff_el = author.find("AffiliationInfo/Affiliation")
                        if aff_el is not None:
                            affiliation = "".join(aff_el.itertext()).strip()

                # DOI
                doi = None
                for id_el in article.findall(".//ArticleId"):
                    if id_el.get("IdType") == "doi":
                        doi = id_el.text
                        break

                pmid = medline.findtext("PMID", "")

                # Abstract (structured or plain)
                abstract_parts = []
                for ab in art.findall(".//AbstractText"):
                    label = ab.get("Label")
                    text = "".join(ab.itertext()).strip()
                    if label and text:
                        abstract_parts.append(f"{label}: {text}")
                    elif text:
                        abstract_parts.append(text)
                abstract = " ".join(abstract_parts)

                # Skip predatory publishers
                journal_lower = journal.lower()
                if any(kw in journal_lower for kw in _PREDATORY_PUBLISHERS):
                    continue

                papers.append({
                    "pmid": pmid,
                    "title": title,
                    "authors": authors,
                    "affiliation": affiliation[:150] if affiliation else "",
                    "journal": journal,
                    "year": year,
                    "doi": doi,
                    "abstract": abstract[:1000] if abstract else "",
                    "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    "citations": None,
                })

            # Step 4: enrich with citation counts from Crossref (parallel)
            def fetch_citations(paper):
                doi = paper.get("doi")
                if not doi:
                    return paper
                try:
                    encoded = urllib.parse.quote(doi, safe="")
                    url = f"https://api.crossref.org/works/{encoded}?mailto=claude-web-ui@local"
                    req = urllib.request.Request(url, headers={"User-Agent": "claude-web-ui/1.0"})
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        paper["citations"] = data.get("message", {}).get("is-referenced-by-count")
                except Exception:
                    pass
                return paper

            with ThreadPoolExecutor(max_workers=5) as pool:
                papers = list(pool.map(fetch_citations, papers))

            # Step 5: sort
            if sort_by == "citations":
                papers.sort(key=lambda p: (p["citations"] is None, -(p["citations"] or 0)))
            elif sort_by == "journal":
                papers.sort(key=lambda p: (
                    _JOURNAL_TIER.get(p["journal"].lower(), _DEFAULT_TIER),
                    p["citations"] is None,
                    -(p["citations"] or 0),
                ))

            result = {"query": q, "total": len(papers), "papers": papers}
            _paper_cache[cache_key] = {"ts": time.time(), "data": result}
            self._send_json(result)

        except Exception as e:
            self._send_json_error(500, f"검색 중 오류가 발생했습니다: {str(e)}")

    def _send_json_error(self, code, message):
        """Send a JSON error response."""
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        resp = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _send_sse(self, data):
        try:
            self.wfile.write(f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
        except Exception:
            pass

    def _handle_chat(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body)
        message = data.get("message", "")
        files = data.get("files", [])
        session_id = data.get("session_id")
        cwd = data.get("cwd", os.path.expanduser("~"))

        # Append file references to the message for Claude CLI
        if files:
            file_parts = []
            for f in files:
                fpath = f.get("path", "")
                ftype = f.get("type", "")
                if not fpath or not os.path.isfile(fpath):
                    continue
                if ftype.startswith("image/"):
                    file_parts.append(f"[첨부 이미지: {fpath}] 이 이미지 파일을 읽어서 확인해주세요.")
                else:
                    file_parts.append(f"이 파일을 참고해주세요: {fpath}")
            if file_parts:
                message = message + "\n\n" + "\n".join(file_parts)

        model = data.get("model", "")
        system_prompt = data.get("system_prompt", "")
        is_paper_study = data.get("paper_study", False)

        # Build command — full Claude Code with all tools, no permission prompts
        cmd = [
            "claude",
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
        ]
        if model:
            cmd += ["--model", model]
        if system_prompt:
            cmd += ["--system-prompt", system_prompt]
        if session_id:
            cmd += ["--resume", session_id]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # Use a mutable key for proc tracking (session_id may update mid-stream)
        proc_key = session_id or f"pending-{uuid.uuid4().hex[:8]}"
        is_new_conversation = not session_id  # True if this is a brand new conversation
        assistant_text_parts = []  # Collect assistant response for title generation

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                cwd=cwd,
            )
            with active_procs_lock:
                active_procs[proc_key] = proc
            proc.stdin.write(message)
            proc.stdin.close()

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    etype = event.get("type", "")

                    if etype == "system" and event.get("subtype") == "init":
                        new_sid = event.get("session_id", "")
                        if new_sid and new_sid != proc_key:
                            with active_procs_lock:
                                active_procs.pop(proc_key, None)
                                active_procs[new_sid] = proc
                                proc_key = new_sid
                        # Save conversation with temporary title
                        if new_sid:
                            title = message[:50].split("\n")[0] if message else "새 대화"
                            self._upsert_conversation(new_sid, title)
                        self._send_sse({
                            "type": "init",
                            "session_id": new_sid,
                            "model": event.get("model", ""),
                            "cwd": event.get("cwd", ""),
                        })

                    elif etype == "assistant" and "message" in event:
                        msg = event["message"]
                        sid = event.get("session_id", "")
                        for block in msg.get("content", []):
                            if block.get("type") == "text":
                                self._send_sse({"type": "text", "text": block["text"]})
                                assistant_text_parts.append(block["text"])
                            elif block.get("type") == "tool_use":
                                self._send_sse({
                                    "type": "tool_use",
                                    "tool": block.get("name", ""),
                                    "input": block.get("input", {}),
                                    "id": block.get("id", ""),
                                })
                        if sid:
                            self._send_sse({"type": "session_id", "session_id": sid})

                    elif etype == "user":
                        # Tool results come as user messages
                        msg = event.get("message", {})
                        for block in msg.get("content", []):
                            if isinstance(block, dict) and block.get("type") == "tool_result":
                                content = block.get("content", "")
                                text = ""
                                if isinstance(content, list):
                                    for c in content:
                                        if isinstance(c, dict) and c.get("type") == "text":
                                            text += c.get("text", "")
                                elif isinstance(content, str):
                                    text = content
                                self._send_sse({
                                    "type": "tool_result",
                                    "tool_use_id": block.get("tool_use_id", ""),
                                    "content": text[:2000],  # truncate large results for display
                                    "is_error": block.get("is_error", False),
                                })

                    elif etype == "result":
                        text = event.get("result", "")
                        usage = event.get("usage", {})
                        result_sid = event.get("session_id", "")
                        self._send_sse({
                            "type": "result",
                            "text": text,
                            "session_id": result_sid,
                            "input_tokens": usage.get("input_tokens", 0),
                            "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                            "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
                            "output_tokens": usage.get("output_tokens", 0),
                            "cost_usd": round(event.get("total_cost_usd", 0), 4),
                            "duration_ms": event.get("duration_ms", 0),
                            "num_turns": event.get("num_turns", 1),
                        })
                        # Generate AI title for new conversations
                        if is_new_conversation and result_sid:
                            assistant_full = "".join(assistant_text_parts)
                            if not assistant_full and text:
                                assistant_full = text
                            sse_writer = self._send_sse
                            threading.Thread(
                                target=self._generate_title_async,
                                args=(result_sid, message, assistant_full, sse_writer),
                                daemon=True,
                            ).start()
                        # Auto-update wiki after paper study
                        if is_paper_study:
                            wiki_text = "".join(assistant_text_parts)
                            if not wiki_text and text:
                                wiki_text = text
                            if wiki_text:
                                threading.Thread(
                                    target=self._update_wiki_async,
                                    args=(wiki_text, self._send_sse),
                                    daemon=True,
                                ).start()

                except json.JSONDecodeError:
                    continue

            proc.wait()
            with active_procs_lock:
                active_procs.pop(proc_key, None)
            self._send_sse({"type": "done"})
        except BrokenPipeError:
            with active_procs_lock:
                active_procs.pop(proc_key, None)
        except Exception as e:
            with active_procs_lock:
                active_procs.pop(proc_key, None)
            self._send_sse({"type": "error", "error": str(e)})


class ThreadedHTTPServer(http.server.HTTPServer):
    def process_request(self, request, client_address):
        t = threading.Thread(target=self._handle, args=(request, client_address))
        t.daemon = True
        t.start()

    def _handle(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


def main():
    server = ThreadedHTTPServer((HOST, PORT), ChatHandler)
    print(f"\n  Claude Code Web UI: http://{HOST}:{PORT}\n")
    print(f"  localhost only / Ctrl+C to stop\n")

    def shutdown(sig, frame):
        print("\n  Shutting down...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    server.serve_forever()


if __name__ == "__main__":
    main()
