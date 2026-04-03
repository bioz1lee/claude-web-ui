const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const modelInfoEl = document.getElementById("model-info");
const newChatBtn = document.getElementById("new-chat");
const attachImageBtn = document.getElementById("attach-image-btn");
const attachFileBtn = document.getElementById("attach-file-btn");
const imageFileInput = document.getElementById("image-file-input");
const generalFileInput = document.getElementById("general-file-input");
const attachmentsPreview = document.getElementById("attachments-preview");
const inputArea = document.getElementById("input-area");
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const convList = document.getElementById("conversation-list");
const modelSelect = document.getElementById("model-select");

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-close");
const settingsSave = document.getElementById("settings-save");
const systemPromptInput = document.getElementById("system-prompt-input");
const cwdInput = document.getElementById("cwd-input");

// Settings modal
settingsBtn.addEventListener("click", () => {
  systemPromptInput.value = localStorage.getItem("system_prompt") || "";
  cwdInput.value = localStorage.getItem("cwd") || "";
  settingsModal.style.display = "flex";
});
settingsClose.addEventListener("click", () => settingsModal.style.display = "none");
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.style.display = "none"; });
settingsSave.addEventListener("click", () => {
  localStorage.setItem("system_prompt", systemPromptInput.value);
  localStorage.setItem("cwd", cwdInput.value);
  settingsModal.style.display = "none";
  showToast("설정이 저장되었습니다", "success");
});

const PAPER_STUDY_PROMPT = `첨부 논문을 분석해줘. 아래 포맷을 정확히 따라. 구구절절 쓰지 마.

## 1) 배경 Context (2-3줄)
이 연구가 왜 중요한지, 기존 연구 landscape에서 어떤 gap을 메우는지 간결하게.

## 2) 요약 5줄
- **What:** 이 논문이 뭔지 한 줄
- **How:** 핵심 방법론 한 줄
- **Key Result:** 가장 중요한 결과 한 줄 (수치 포함)
- **So What:** 이 결과가 왜 중요한지 한 줄
- **Limitation:** 핵심 한계 한 줄

## 3) Story Flow
Fig1→Fig2→...→한줄결론 형태로. 각 figure가 전체 스토리에서 어떤 역할인지 화살표로 연결.

## 4) Figure 표 (main figures만, 출력의 60%↑)
|Panel|보여주는 것(10단어↓)|핵심결과(1문장)|읽는 법(뭘 봐야 하는지 한 줄)|
Schematic panel은 한마디로 요약.
Extended Data는 "Extended Data Fig X에서 추가 검증" 식으로 언급만.
Architecture 세부 panel은 한 줄 요약으로 축소.

## 5) 전문용어 Glossary
논문에 등장하는 핵심 전문용어를 표로 정리.
|용어|한줄 설명|
전문용어는 영어, 설명은 한국어.

## 6) Limitation 심화 (3-4가지)
각 한계점마다: 무엇이 한계인지 + 왜 한계인지 + 후속 연구 방향 한 줄.

## 7) 실용 포인트
"내 연구에 어떻게 쓸 수 있나?" 관점에서 3가지 구체적 활용 시나리오.`;

let sessionId = null;
let sending = false;
let abortController = null;
let lastInputTokens = 0;
let lastNumTurns = 0;
const MODEL_CONTEXT = {
  "claude-opus-4-6": 1000000,
  "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "": 200000
};
let maxContext = 200000;
let loadingStartTime = null;
let loadingInterval = null;
let toolBlocks = {};  // id -> DOM element
let attachments = []; // { file_path, original_name, size, type, localUrl? }
let lastAssistantText = ""; // track last assistant response for bookmarking
let paperStudyMode = false;
let lastSentPayload = null;

showEmpty();

// Model select → update maxContext
modelSelect.addEventListener("change", () => {
  maxContext = MODEL_CONTEXT[modelSelect.value] || 200000;
  if (lastInputTokens) updateContextBar();
});

// --- Sidebar ---
let sidebarTab = "conversations";
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("open");
  if (sidebar.classList.contains("open")) {
    if (sidebarTab === "bookmarks") loadBookmarks(); else loadConversations();
  }
});
sidebarClose.addEventListener("click", () => sidebar.classList.remove("open"));

// Sidebar tabs
document.querySelectorAll(".sidebar-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".sidebar-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    sidebarTab = tab.dataset.tab;
    if (sidebarTab === "bookmarks") loadBookmarks(); else loadConversations();
  });
});

// --- Message persistence ---
async function saveMessage(sid, role, content) {
  if (!sid) return;
  try {
    await fetch(`/api/conversations/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content, timestamp: new Date().toISOString() }),
    });
  } catch (e) { console.error("Failed to save message:", e); }
}

async function loadMessages(sid) {
  try {
    const resp = await fetch(`/api/conversations/${sid}/messages`);
    if (!resp.ok) return [];
    return await resp.json();
  } catch (e) { console.error("Failed to load messages:", e); return []; }
}

let streamingSessionId = null; // track which session is currently streaming
let searchQuery = "";
const sidebarSearchInput = document.getElementById("sidebar-search-input");

function getDateGroup(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  const nowDay = now.getDay(); // 0=일
  const daysSinceMonday = (nowDay + 6) % 7;
  if (diffDays === 0) return "오늘";
  if (diffDays === 1) return "어제";
  if (diffDays <= daysSinceMonday) return "이번 주";
  if (diffDays <= daysSinceMonday + 7) return "지난 주";
  return "이전";
}

sidebarSearchInput.addEventListener("input", (() => {
  let timer;
  return (e) => {
    clearTimeout(timer);
    searchQuery = e.target.value.trim();
    timer = setTimeout(() => {
      if (sidebarTab === "conversations") loadConversations();
      else if (sidebarTab === "bookmarks") loadBookmarks();
    }, 150);
  };
})());

async function loadConversations() {
  try {
    const resp = await fetch("/api/conversations");
    const convos = await resp.json();
    convList.innerHTML = "";

    // Show pinned running chat indicator if streaming and viewing a different chat
    if (sending && streamingSessionId && streamingSessionId !== sessionId) {
      const runningConvo = convos.find(c => c.session_id === streamingSessionId);
      if (runningConvo) {
        const pin = document.createElement("div");
        pin.className = "conv-item conv-item-running";
        pin.innerHTML = `
          <div class="conv-item-text">
            <div class="conv-item-title"><span class="running-dot"></span>${escapeHtml(runningConvo.title)}</div>
            <div class="conv-item-date running-label">응답 생성 중…</div>
          </div>
        `;
        pin.addEventListener("click", async () => {
          sessionId = streamingSessionId;
          messagesEl.innerHTML = "";
          const messages = await loadMessages(streamingSessionId);
          for (const msg of messages) {
            const div = addMessage(msg.role, msg.content);
            if (msg.role === "assistant") addBookmarkBtn(div, msg.content);
          }
          sidebar.classList.remove("open");
          loadConversations();
        });
        convList.appendChild(pin);
      }
    }

    // 검색 필터
    const filtered = searchQuery
      ? convos.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
      : convos;

    if (filtered.length === 0) {
      convList.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">${searchQuery ? "검색 결과가 없습니다" : "아직 대화가 없어요"}</div>`;
      return;
    }

    // 날짜 그룹핑
    const groups = {};
    const groupOrder = ["오늘", "어제", "이번 주", "지난 주", "이전"];
    for (const c of filtered) {
      const g = getDateGroup(c.updated_at);
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    }

    for (const groupName of groupOrder) {
      if (!groups[groupName]) continue;
      // 그룹 헤더 (검색 중이면 생략)
      if (!searchQuery) {
        const label = document.createElement("div");
        label.className = "conv-group-label";
        label.textContent = groupName;
        convList.appendChild(label);
      }
      for (const c of groups[groupName]) {
        const item = document.createElement("div");
        item.className = "conv-item" + (c.session_id === sessionId ? " active" : "");
        const date = new Date(c.updated_at).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
        item.innerHTML = `
          <div class="conv-item-text">
            <div class="conv-item-title">${escapeHtml(c.title)}</div>
            <div class="conv-item-date">${date}</div>
          </div>
          <button class="conv-item-delete" title="삭제">&times;</button>
        `;
        item.querySelector(".conv-item-text").addEventListener("click", async () => {
          sessionId = c.session_id;
          messagesEl.innerHTML = "";
          const messages = await loadMessages(c.session_id);
          if (messages.length > 0) {
            for (const msg of messages) {
              const div = addMessage(msg.role, msg.content);
              if (msg.role === "assistant") addBookmarkBtn(div, msg.content);
            }
          } else {
            addMessage("assistant", `이전 대화를 이어갑니다: "${escapeHtml(c.title)}"\n\n메시지를 입력하면 이전 대화에 이어서 응답합니다.`);
          }
          sidebar.classList.remove("open");
          loadConversations();
        });
        item.querySelector(".conv-item-delete").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("이 대화를 삭제하시겠습니까?")) return;
          await fetch(`/api/conversations/${c.session_id}`, { method: "DELETE" });
          if (sessionId === c.session_id) { sessionId = null; showEmpty(); }
          loadConversations();
        });
        convList.appendChild(item);
      }
    }
  } catch (e) { console.error("Failed to load conversations:", e); }
}

// --- Attachment handling ---

attachImageBtn.addEventListener("click", () => imageFileInput.click());
attachFileBtn.addEventListener("click", () => generalFileInput.click());

// Local path attachment (no upload/copy)
const attachPathBtn = document.getElementById("attach-path-btn");
const pathInputRow = document.getElementById("path-input-row");
const pathInput = document.getElementById("path-input");
const pathInputConfirm = document.getElementById("path-input-confirm");
const pathInputCancel = document.getElementById("path-input-cancel");

attachPathBtn.addEventListener("click", () => {
  pathInputRow.style.display = "flex";
  pathInput.value = "";
  pathInput.focus();
});
pathInputCancel.addEventListener("click", () => { pathInputRow.style.display = "none"; });
pathInputConfirm.addEventListener("click", confirmPathAttachment);
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); confirmPathAttachment(); }
  if (e.key === "Escape") pathInputRow.style.display = "none";
});

function confirmPathAttachment() {
  const rawPath = pathInput.value.trim();
  if (!rawPath) return;
  // Normalize ~ to home dir representation (server will handle actual path)
  const displayName = rawPath.split("/").pop() || rawPath;
  const mime = rawPath.toLowerCase().endsWith(".pdf") ? "application/pdf"
    : rawPath.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? "image/" + rawPath.split(".").pop().toLowerCase()
    : "application/octet-stream";

  attachments.push({
    id: Date.now() + "-local",
    file_path: rawPath,
    original_name: displayName,
    size: null,
    type: mime,
    localUrl: null,
    uploading: false,
    isLocalPath: true,
  });
  renderAttachments();
  pathInputRow.style.display = "none";
}

imageFileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  imageFileInput.value = "";
});

generalFileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  generalFileInput.value = "";
});

// Drag and drop
inputArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputArea.classList.add("drag-over");
});

inputArea.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  // Only remove if leaving the input-area itself
  if (!inputArea.contains(e.relatedTarget)) {
    inputArea.classList.remove("drag-over");
  }
});

inputArea.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputArea.classList.remove("drag-over");
  if (e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

// Clipboard paste (Cmd+V / Ctrl+V for images)
inputEl.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) handleFiles([file]);
      return;
    }
  }
});

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB — must match server

function handleFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_FILE_SIZE) {
      showToast(`파일이 너무 커요: ${file.name} (${formatFileSize(file.size)}). 최대 ${formatFileSize(MAX_FILE_SIZE)}`, "error");
      continue;
    }
    uploadFile(file);
  }
}

async function uploadFile(file) {
  const tempId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const isImage = file.type.startsWith("image/");
  let localUrl = null;

  // Create preview immediately (with uploading state)
  if (isImage) {
    localUrl = URL.createObjectURL(file);
  }

  const tempAttachment = {
    id: tempId,
    file_path: null,
    original_name: file.name,
    size: file.size,
    type: file.type,
    localUrl: localUrl,
    uploading: true,
  };
  attachments.push(tempAttachment);
  renderAttachments();

  try {
    const formData = new FormData();
    formData.append("file", file);

    const resp = await fetch("/api/upload", { method: "POST", body: formData });
    if (!resp.ok) throw new Error("Upload failed: " + resp.status);

    const data = await resp.json();
    // Update attachment with server path
    tempAttachment.file_path = data.file_path;
    tempAttachment.uploading = false;
    renderAttachments();
  } catch (err) {
    // Remove failed upload
    attachments = attachments.filter(a => a.id !== tempId);
    renderAttachments();
    showToast(`업로드 실패: ${file.name}`, "error");
  }
}

function renderAttachments() {
  attachmentsPreview.innerHTML = "";
  for (const att of attachments) {
    const isImage = att.type && att.type.startsWith("image/");
    const item = document.createElement("div");
    item.className = "attachment-item " + (isImage ? "image-item" : "file-item") + (att.uploading ? " uploading" : "");

    if (isImage && att.localUrl) {
      const img = document.createElement("img");
      img.src = att.localUrl;
      img.alt = att.original_name;
      item.appendChild(img);
    } else {
      item.innerHTML = `
        <svg class="file-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <div class="file-item-info">
          <div class="file-item-name">${escapeHtml(att.original_name)}</div>
          <div class="file-item-size">${formatFileSize(att.size)}</div>
        </div>
      `;
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "attachment-remove";
    removeBtn.setAttribute("aria-label", "첨부 파일 제거");
    removeBtn.innerHTML = "&times;";
    removeBtn.onclick = () => {
      if (att.localUrl) URL.revokeObjectURL(att.localUrl);
      attachments = attachments.filter(a => a.id !== att.id);
      renderAttachments();
    };
    item.appendChild(removeBtn);

    attachmentsPreview.appendChild(item);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function showEmpty() {
  messagesEl.innerHTML = `
    <div class="empty-state">
      <svg class="empty-logo" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect width="48" height="48" rx="12" fill="var(--accent)" opacity="0.12"/>
        <path d="M16 20c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M20 28c-2.2 0-4 1.8-4 4v2h16v-2c0-2.2-1.8-4-4-4" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="24" cy="20" r="3" fill="var(--accent)" opacity="0.3"/>
      </svg>
      <div class="empty-title">Claude Code</div>
      <div class="empty-subtitle">무엇을 도와드릴까요?</div>
      <div class="empty-chips">
        <button class="empty-chip" data-skill="paper-study">Paper Study</button>
        <button class="empty-chip" data-prompt="다음 분석을 수행하는 Python 또는 R 코드를 작성해줘. 입력 데이터 형식, 주요 파라미터 설명, 시각화까지 포함해줘. 분석 내용: ">분석 코드 작성</button>
        <button class="empty-chip" data-prompt="이 코드를 리뷰해줘. 버그, 비효율적인 부분, 생물학적으로 부적절한 파라미터 설정이 있는지 확인하고 개선안을 제시해줘">Bio 코드 리뷰</button>
        <button class="empty-chip" data-prompt="다음 분석 결과를 바탕으로 논문 수준의 글을 작성해줘. Methods, Results, 또는 figure legend 중 필요한 섹션을 지정할게. 학술적 톤으로, 재현 가능하도록 구체적으로 작성해줘. 내용: ">논문 작성 지원</button>
      </div>
    </div>
  `;
  messagesEl.querySelectorAll(".empty-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      if (chip.dataset.skill === "paper-study") {
        paperStudyMode = true;
        document.getElementById("paper-study-banner").style.display = "flex";
        inputEl.placeholder = "추가 지시사항 입력 (선택사항)";
        inputEl.dispatchEvent(new Event("input"));
      } else {
        inputEl.value = chip.dataset.prompt;
        inputEl.dispatchEvent(new Event("input"));
      }
      inputEl.focus();
    });
  });
}

function clearPaperStudyMode() {
  paperStudyMode = false;
  const banner = document.getElementById("paper-study-banner");
  if (banner) banner.style.display = "none";
  inputEl.placeholder = "메시지를 입력하세요... (Shift+Enter: 줄바꿈)";
}

document.getElementById("paper-study-cancel").addEventListener("click", () => {
  clearPaperStudyMode();
  inputEl.focus();
});

newChatBtn.addEventListener("click", () => {
  sessionId = null;
  toolBlocks = {};
  lastInputTokens = 0;
  lastNumTurns = 0;
  document.getElementById("context-bar").style.display = "none";
  document.querySelector("header").classList.remove("has-context-bar");
  // Clear any pending attachments
  for (const att of attachments) {
    if (att.localUrl) URL.revokeObjectURL(att.localUrl);
  }
  attachments = [];
  renderAttachments();
  clearPaperStudyMode();
  showEmpty();
  inputEl.focus();
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", () => {
  if (sending) { abortResponse(); } else { sendMessage(); }
});

function abortResponse() {
  if (abortController) abortController.abort();
  fetch("/api/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
  stopLoading();
  sending = false;
  sendBtn.classList.remove("stop-mode");
  sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  sendBtn.disabled = false;
  inputEl.focus();
}

// Loading timer
let loadingOverrideText = null;

function startLoading(el, opts = {}) {
  loadingStartTime = Date.now();
  loadingOverrideText = null;

  const hasPdf = opts.hasPdf || false;
  const hasFiles = opts.hasFiles || false;

  const defaultPhases = [
    { after: 0,     text: "연결 중" },
    { after: 1500,  text: "응답 생성 중" },
    { after: 10000, text: "도구 실행 중" },
    { after: 30000, text: "작업 처리 중" },
    { after: 60000, text: "심층 분석 중... 조금만 기다려주세요" },
    { after: 120000, text: "거의 완료 중... 잠시만요" },
  ];

  const pdfPhases = [
    { after: 0,     text: "연결 중" },
    { after: 1500,  text: "논문 읽는 중..." },
    { after: 8000,  text: "논문 내용 분석 중..." },
    { after: 20000, text: "핵심 내용 정리 중..." },
    { after: 40000, text: "심층 분석 중... 조금만 기다려주세요" },
    { after: 80000, text: "분석 마무리 중... 잠시만요" },
    { after: 120000, text: "거의 완료 중... 잠시만요" },
  ];

  const filePhases = [
    { after: 0,     text: "연결 중" },
    { after: 1500,  text: "파일 읽는 중..." },
    { after: 8000,  text: "파일 분석 중..." },
    { after: 20000, text: "내용 정리 중..." },
    { after: 40000, text: "심층 분석 중... 조금만 기다려주세요" },
    { after: 80000, text: "분석 마무리 중... 잠시만요" },
    { after: 120000, text: "거의 완료 중... 잠시만요" },
  ];

  const phases = hasPdf ? pdfPhases : hasFiles ? filePhases : defaultPhases;

  function update() {
    const elapsed = Date.now() - loadingStartTime;
    const secs = Math.floor(elapsed / 1000);
    let phase;
    if (loadingOverrideText) {
      phase = loadingOverrideText;
    } else {
      phase = phases[0].text;
      for (const p of phases) {
        if (elapsed >= p.after) phase = p.text;
      }
    }
    el.innerHTML = `<div class="loading-indicator">
      <span class="loading-spinner"></span>
      <span>${phase}</span>
      <span class="loading-time">${secs}s</span>
    </div>`;
  }

  update();
  loadingInterval = setInterval(update, 500);
}

function setLoadingOverride(text) {
  loadingOverrideText = text;
}

function stopLoading() {
  if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
  loadingOverrideText = null;
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text && attachments.length === 0) return;
  if (sending) return;

  if (messagesEl.querySelector(".empty-state")) messagesEl.innerHTML = "";

  // Collect file info from attachments (format expected by server)
  const files = attachments
    .filter(a => a.file_path && !a.uploading)
    .map(a => ({ path: a.file_path, type: a.type || "application/octet-stream" }));

  // Build display text (show attached file names)
  let displayText = text;
  if (attachments.length > 0) {
    const names = attachments.map(a => a.original_name);
    displayText = (text ? text + "\n" : "") + "[첨부: " + names.join(", ") + "]";
  }

  sending = true;
  streamingSessionId = sessionId; // will update after init if new chat
  abortController = new AbortController();
  sendBtn.disabled = false;
  sendBtn.classList.add("stop-mode");
  sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>`;
  inputEl.value = "";
  inputEl.style.height = "auto";

  // Capture PDF URL for paper study figure gallery (must be before attachments are cleared)
  let thisPaperStudyPdfUrl = null;
  if (paperStudyMode) {
    const pdfAtt = attachments.find(a => a.type === 'application/pdf' && !a.uploading);
    if (pdfAtt && pdfAtt.file_path) {
      thisPaperStudyPdfUrl = pdfAtt.isLocalPath
        ? '/api/local?path=' + encodeURIComponent(pdfAtt.file_path)
        : '/uploads/' + pdfAtt.file_path.split('/').pop();
    }
  }

  // Clear attachments
  for (const att of attachments) {
    if (att.localUrl) URL.revokeObjectURL(att.localUrl);
  }
  attachments = [];
  renderAttachments();

  addMessage("user", displayText);
  // Save user message (sessionId may update after init event, save later if needed)
  const pendingUserMsg = displayText;

  const assistantEl = addMessage("assistant", "");
  const contentEl = assistantEl.querySelector(".message-content");
  const hasPdf = files.some(f => f.type === "application/pdf" || (f.path && f.path.toLowerCase().endsWith(".pdf")));
  const hasFiles = files.length > 0;
  startLoading(contentEl, { hasPdf, hasFiles });

  const metaEl = document.createElement("div");
  metaEl.className = "message-meta";
  assistantEl.appendChild(metaEl);

  let gotContent = false;
  let textParts = [];  // collect text segments in order
  let contentParts = []; // mixed text + tool refs for final render

  // paperStudyMode: prepend the analysis prompt
  let messageText = text;
  if (paperStudyMode) {
    messageText = PAPER_STUDY_PROMPT + (text ? "\n\n추가 지시사항: " + text : "");
    clearPaperStudyMode();
  }

  const payload = { message: messageText, session_id: sessionId };
  if (modelSelect.value) payload.model = modelSelect.value;
  const sp = localStorage.getItem("system_prompt");
  if (sp) payload.system_prompt = sp;
  const userCwd = localStorage.getItem("cwd");
  if (userCwd) payload.cwd = userCwd;
  if (files.length > 0) payload.files = files;
  lastSentPayload = payload;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "init") {
            if (event.session_id) { sessionId = event.session_id; streamingSessionId = event.session_id; }
            // Save user message now that we have session_id
            if (sessionId) saveMessage(sessionId, "user", pendingUserMsg);
            if (event.model) {
              modelInfoEl.textContent = event.model;
              // Update maxContext based on actual model
              for (const [key, val] of Object.entries(MODEL_CONTEXT)) {
                if (key && event.model.includes(key)) { maxContext = val; break; }
              }
            }
          }

          else if (event.type === "text") {
            if (!gotContent) { stopLoading(); contentEl.innerHTML = ""; gotContent = true; }
            // Append or update last text segment
            if (contentParts.length === 0 || contentParts[contentParts.length - 1].type !== "text") {
              contentParts.push({ type: "text", text: event.text });
            } else {
              contentParts[contentParts.length - 1].text = event.text;
            }
            renderContent(contentEl, contentParts);
            scrollToBottom();
          }

          else if (event.type === "tool_use") {
            if (!gotContent) { stopLoading(); contentEl.innerHTML = ""; gotContent = true; }
            const toolEl = createToolBlock(event.tool, event.input, event.id);
            contentParts.push({ type: "tool", id: event.id, el: toolEl });
            renderContent(contentEl, contentParts);
            scrollToBottom();
          }

          else if (event.type === "tool_result") {
            const tb = toolBlocks[event.tool_use_id];
            if (tb) {
              // Check if terminal-style or legacy section-style
              const termOutput = tb.querySelector(".term-output");
              const legacyOutput = tb.querySelector(".tool-output");
              const statusEl = tb.querySelector(".tool-status");
              const content = event.content || "(빈 결과)";

              if (termOutput) {
                termOutput.textContent = content;
                if (event.is_error) {
                  termOutput.classList.add("error");
                  statusEl.textContent = "오류";
                  statusEl.className = "tool-status error";
                } else {
                  statusEl.textContent = "완료";
                  statusEl.className = "tool-status done";
                  tb.classList.add("done");
                }
              } else if (legacyOutput) {
                legacyOutput.textContent = content;
                if (event.is_error) {
                  legacyOutput.classList.add("error");
                  statusEl.textContent = "오류";
                  statusEl.className = "tool-status error";
                } else {
                  statusEl.textContent = "완료";
                  statusEl.className = "tool-status done";
                  tb.classList.add("done");
                }
              }
            }
            // After tool result, expect more text — push a new text segment
            scrollToBottom();
          }

          else if (event.type === "session_id") {
            sessionId = event.session_id;
          }

          else if (event.type === "result") {
            stopLoading();
            if (event.session_id) sessionId = event.session_id;
            // If we never got streaming text, use result text
            if (!gotContent && event.text) {
              contentEl.innerHTML = "";
              gotContent = true;
              contentParts.push({ type: "text", text: event.text });
              renderContent(contentEl, contentParts);
            }
            // Collect final text for saving & bookmarking
            const finalText = contentParts.filter(p => p.type === "text").map(p => p.text).join("\n");
            lastAssistantText = finalText;
            if (sessionId && finalText) saveMessage(sessionId, "assistant", finalText);
            addBookmarkBtn(assistantEl, finalText);
            // Stats
            const stats = [];
            if (event.input_tokens) {
              let inStr = `입력 ${event.input_tokens.toLocaleString()}토큰`;
              if (event.cache_read_tokens) inStr += ` (캐시 ${event.cache_read_tokens.toLocaleString()})`;
              stats.push(inStr);
            }
            if (event.output_tokens) stats.push(`출력 ${event.output_tokens.toLocaleString()}토큰`);
            if (event.duration_ms) stats.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
            if (event.cost_usd) stats.push(`$${event.cost_usd}`);
            if (event.num_turns > 1) stats.push(`${event.num_turns} turns`);
            if (stats.length) {
              metaEl.innerHTML = stats.join("  &middot;  ") + '<span class="response-done-badge">응답 완료</span>';
            } else {
              metaEl.innerHTML = '<span class="response-done-badge">응답 완료</span>';
            }

            // Update context bar
            lastInputTokens = (event.input_tokens || 0) + (event.cache_read_tokens || 0);
            lastNumTurns = event.num_turns || lastNumTurns;
            updateContextBar();
            // 스트리밍 완료 — 연속 tool block을 그룹으로 묶어 재렌더링
            renderContent(contentEl, contentParts, true);
            if (thisPaperStudyPdfUrl) {
              renderPdfFigureGallery(contentEl, thisPaperStudyPdfUrl);
            }
            scrollToBottom();
          }

          else if (event.type === "title_update") {
            // AI-generated title arrived — refresh sidebar
            if (sidebarTab === "conversations") loadConversations();
          }

          else if (event.type === "error") {
            stopLoading();
            if (!gotContent) contentEl.innerHTML = "";
            addErrorBlock(contentEl, event.error || "알 수 없는 오류");
          }
        } catch (e) { /* skip */ }
      }
    }

    stopLoading();
    if (!gotContent) {
      contentEl.innerHTML = '<span style="color:var(--text-muted)">응답 없음</span>';
    }
    // If we got content but no result event (no meta badge yet), add done badge
    if (gotContent && !metaEl.innerHTML) {
      metaEl.innerHTML = '<span class="response-done-badge">응답 완료</span>';
    }
  } catch (err) {
    stopLoading();
    if (err.name !== "AbortError") {
      addErrorBlock(contentEl, err.message || "연결 오류");
    }
  }

  sending = false;
  streamingSessionId = null;
  abortController = null;
  sendBtn.classList.remove("stop-mode");
  // Refresh sidebar to remove running indicator
  if (sidebar.classList.contains("open") && sidebarTab === "conversations") loadConversations();
  sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  sendBtn.disabled = false;
  inputEl.focus();
}

function classifyError(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("rate") || m.includes("429") || m.includes("quota")) return "rate_limit";
  if (m.includes("auth") || m.includes("401") || m.includes("403") || m.includes("api_key") || m.includes("invalid x-api-key")) return "auth";
  if (m.includes("context") || m.includes("too long") || m.includes("max_tokens") || m.includes("token limit")) return "context";
  if (m.includes("abort") || m.includes("cancel")) return "aborted";
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to fetch") || m.includes("connection")) return "network";
  return "unknown";
}

function getErrorInfo(type) {
  const map = {
    rate_limit:  { label: "요청 한도 초과", hint: "잠시 후 다시 시도하세요.", action: "retry" },
    auth:        { label: "인증 오류", hint: "API 키를 확인하세요.", action: null },
    context:     { label: "컨텍스트 초과", hint: "새 대화를 시작하거나 대화를 줄여보세요.", action: "new_chat" },
    network:     { label: "연결 오류", hint: "네트워크 상태를 확인하세요.", action: "retry" },
    aborted:     { label: "중단됨", hint: "응답이 중단되었습니다.", action: "retry" },
    unknown:     { label: "오류 발생", hint: "잠시 후 다시 시도해보세요.", action: "retry" },
  };
  return map[type] || map.unknown;
}

function addErrorBlock(contentEl, errorText) {
  const type = classifyError(errorText);
  if (type === "aborted") return; // 사용자가 직접 중단 — UI 노이즈 불필요
  const info = getErrorInfo(type);
  const block = document.createElement("div");
  block.className = "error-block";
  let actionHtml = "";
  if (info.action === "retry") {
    actionHtml = `<button class="error-action-btn" onclick="retryLast()">다시 시도</button>`;
  } else if (info.action === "new_chat") {
    actionHtml = `<button class="error-action-btn" onclick="document.getElementById('new-chat').click()">새 대화</button>`;
  }
  block.innerHTML = `
    <div class="error-block-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="error-block-label">${info.label}</span>
    </div>
    <div class="error-block-hint">${info.hint}</div>
    <div class="error-block-detail">${escapeHtml(errorText)}</div>
    ${actionHtml}
  `;
  contentEl.appendChild(block);
}

async function ensurePdfJs() {
  if (window.pdfjsLib) return true;
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(true);
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function renderPdfFigureGallery(contentEl, pdfUrl) {
  const ok = await ensurePdfJs();
  if (!ok) return;

  // DOM 안정화 대기
  await new Promise(r => requestAnimationFrame(r));

  // Figure 표 h2 찾기
  let figHeading = null;
  for (const h of contentEl.querySelectorAll('h2')) {
    if (/figure|fig/i.test(h.textContent)) { figHeading = h; break; }
  }
  if (!figHeading) return;

  // 인접한 table 찾기
  let tableEl = null;
  let el = figHeading.nextElementSibling;
  while (el) {
    if (el.tagName === 'TABLE') { tableEl = el; break; }
    if (/^H[123]$/.test(el.tagName)) break;
    el = el.nextElementSibling;
  }
  if (!tableEl) return;

  // 헤더 파싱 — "Panel" 컬럼 위치 확인
  const headers = Array.from(tableEl.querySelectorAll('thead th')).map(th => th.textContent.trim());
  const panelIdx = headers.findIndex(h => /^panel$/i.test(h));
  const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
  if (!rows.length) return;

  // 로딩 표시
  const loadingEl = document.createElement('div');
  loadingEl.className = 'figure-loading';
  loadingEl.textContent = 'Figure 이미지 매칭 중...';
  figHeading.insertAdjacentElement('afterend', loadingEl);

  // PDF 로드
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(pdfUrl).promise;
  } catch (e) {
    loadingEl.remove();
    return;
  }

  // 각 페이지 텍스트 추출 (figure 위치 매칭용)
  const pageIndex = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ');
    pageIndex.push({ pageNum: i, page, text });
  }

  // 피겨 번호로 가장 적합한 페이지 찾기
  // 텍스트가 적은 페이지 선호 (figure page는 캡션 외 텍스트가 적음)
  function findPageForFig(figNum) {
    const pat = new RegExp(`\\bfig(?:ure|\\.)?\\s*\\.?\\s*${figNum}(?=[^\\d]|$)`, 'i');
    const matches = pageIndex.filter(p => pat.test(p.text));
    if (!matches.length) return null;
    return matches.reduce((best, p) => (!best || p.text.length < best.text.length) ? p : best, null);
  }

  // 페이지 → canvas 렌더 (1.3 scale)
  const SCALE = 1.3;
  async function renderPage(pd) {
    const vp = pd.page.getViewport({ scale: SCALE });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await pd.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }

  // Figure 카드 생성 (table 교체)
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (!cells.length) continue;

    const panelText = (panelIdx >= 0 ? cells[panelIdx] : cells[0])?.textContent.trim() || '';
    const figMatch = panelText.match(/fig(?:ure|\.?)\.?\s*(\d+)/i);
    const figNum = figMatch ? parseInt(figMatch[1]) : null;

    const card = document.createElement('div');
    card.className = 'figure-card';

    // 이미지 섹션
    if (figNum !== null) {
      const pd = findPageForFig(figNum);
      if (pd) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'figure-card-img';
        const canvas = await renderPage(pd);
        canvas.title = `p.${pd.pageNum} — 클릭하여 확대`;
        canvas.addEventListener('click', () => openFigureFullView(pd));
        const pgLbl = document.createElement('span');
        pgLbl.className = 'figure-card-page-label';
        pgLbl.textContent = `p.${pd.pageNum}`;
        imgWrap.appendChild(canvas);
        imgWrap.appendChild(pgLbl);
        card.appendChild(imgWrap);
      }
    }

    // 정보 섹션 (table row 내용)
    const info = document.createElement('div');
    info.className = 'figure-card-info';
    headers.forEach((hdr, ci) => {
      const val = cells[ci]?.innerHTML || '';
      if (!val.trim()) return;
      const line = document.createElement('div');
      line.className = 'figure-card-row';
      line.innerHTML = `<span class="figure-card-key">${escapeHtml(hdr)}</span><span class="figure-card-val">${val}</span>`;
      info.appendChild(line);
    });
    card.appendChild(info);
    fragment.appendChild(card);
  }

  loadingEl.remove();
  tableEl.replaceWith(fragment);
}

function openFigureFullView(pd) {
  let overlay = document.getElementById('fig-full-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fig-full-overlay';
    overlay.className = 'fig-full-overlay';
    overlay.innerHTML = `
      <div class="fig-overlay-bg"></div>
      <div class="fig-overlay-inner">
        <canvas class="fig-overlay-canvas"></canvas>
        <button class="fig-overlay-close">&times;</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.fig-overlay-bg').addEventListener('click', () => overlay.style.display = 'none');
    overlay.querySelector('.fig-overlay-close').addEventListener('click', () => overlay.style.display = 'none');
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.style.display !== 'none') overlay.style.display = 'none';
    });
  }
  const canvas = overlay.querySelector('.fig-overlay-canvas');
  const vp = pd.page.getViewport({ scale: 2.2 });
  canvas.width = vp.width;
  canvas.height = vp.height;
  pd.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  overlay.style.display = 'flex';
}

async function retryLast() {
  if (!lastSentPayload || sending) return;
  // Remove the last assistant message (the one with error)
  const msgs = messagesEl.querySelectorAll(".message.assistant");
  if (msgs.length > 0) msgs[msgs.length - 1].remove();
  // Re-fill the input with the last message and re-send
  inputEl.value = lastSentPayload.message || "";
  inputEl.dispatchEvent(new Event("input"));
  sendMessage();
}

function groupConsecutiveTools(parts) {
  const grouped = [];
  let i = 0;
  while (i < parts.length) {
    if (parts[i].type === "tool") {
      const tools = [];
      while (i < parts.length && parts[i].type === "tool") {
        tools.push(parts[i]);
        i++;
      }
      if (tools.length >= 2) {
        grouped.push({ type: "tool-group", tools });
      } else {
        grouped.push(tools[0]);
      }
    } else {
      grouped.push(parts[i]);
      i++;
    }
  }
  return grouped;
}

function createToolGroupBlock(tools) {
  const wrapper = document.createElement("div");
  wrapper.className = "tool-group";

  const allDone = tools.every(t => t.el.classList.contains("done"));
  const hasError = tools.some(t => t.el.querySelector(".tool-status.error"));
  const count = tools.length;
  const label = hasError
    ? `${count}개 도구 중 오류 발생`
    : allDone
      ? `${count}개 도구 실행 완료`
      : `${count}개 도구 실행 중...`;

  const header = document.createElement("div");
  header.className = "tool-group-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");
  header.innerHTML = `<span class="tool-group-chevron">&#9654;</span><span class="tool-group-label">${label}</span>`;

  const body = document.createElement("div");
  body.className = "tool-group-body";
  tools.forEach(t => body.appendChild(t.el));

  header.addEventListener("click", () => {
    wrapper.classList.toggle("open");
    header.setAttribute("aria-expanded", wrapper.classList.contains("open"));
  });
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); header.click(); }
  });

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

function renderContent(container, parts, groupTools = false) {
  container.innerHTML = "";
  const hasText = parts.some(p => p.type === "text" && p.text.trim());
  container.classList.toggle("tool-only", !hasText);
  const displayParts = groupTools ? groupConsecutiveTools(parts) : parts;
  for (const part of displayParts) {
    if (part.type === "text") {
      if (!part.text.trim()) continue;
      const div = document.createElement("div");
      div.innerHTML = renderMarkdown(part.text);
      container.appendChild(div);
    } else if (part.type === "tool") {
      container.appendChild(part.el);
    } else if (part.type === "tool-group") {
      container.appendChild(createToolGroupBlock(part.tools));
    }
  }
}

function createToolBlock(tool, input, id) {
  const el = document.createElement("div");
  el.className = "tool-block";
  el.setAttribute("data-tool", tool);

  // Format input nicely
  let inputStr = "";
  if (tool === "Bash" || tool === "bash") {
    inputStr = input.command || JSON.stringify(input, null, 2);
  } else if (tool === "Read") {
    inputStr = input.file_path || JSON.stringify(input, null, 2);
  } else if (tool === "Write" || tool === "Edit") {
    inputStr = input.file_path || "";
    if (input.old_string) inputStr += `\n- ${input.old_string.substring(0, 100)}...`;
    if (input.content) inputStr += `\n(${input.content.length} chars)`;
  } else if (tool === "Glob") {
    inputStr = input.pattern || JSON.stringify(input, null, 2);
  } else if (tool === "Grep") {
    inputStr = input.pattern || JSON.stringify(input, null, 2);
  } else {
    inputStr = JSON.stringify(input, null, 2);
  }

  // Short summary for the header
  let summary = "";
  if (tool === "Read") {
    summary = input.file_path || "";
  } else if (tool === "Write" || tool === "Edit") {
    summary = input.file_path || "";
  } else if (tool === "Bash" || tool === "bash") {
    const cmd = input.command || "";
    summary = cmd.length > 60 ? cmd.substring(0, 60) + "…" : cmd;
  } else if (tool === "Glob") {
    summary = input.pattern || "";
  } else if (tool === "Grep") {
    summary = `"${input.pattern || ""}"`;
  } else if (tool === "Agent") {
    summary = input.description || "";
  }

  // Use terminal-style for Bash, section-style for others
  const isBash = (tool === "Bash" || tool === "bash");
  const isFileOp = (tool === "Read" || tool === "Write" || tool === "Edit" || tool === "Glob" || tool === "Grep");

  if (isBash) {
    el.innerHTML = `
      <div class="tool-header" role="button" tabindex="0" aria-expanded="false" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
        <span class="tool-chevron">&#9654;</span>
        <span class="tool-name">${escapeHtml(tool)}</span>
        ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}
        <span class="tool-status running">실행 중...</span>
      </div>
      <div class="tool-body">
        <div class="tool-terminal"><span class="term-prompt">$ </span><span class="term-cmd">${escapeHtml(inputStr)}</span><span class="term-divider"></span><span class="term-output">⏳</span></div>
      </div>
    `;
  } else if (isFileOp) {
    el.innerHTML = `
      <div class="tool-header" role="button" tabindex="0" aria-expanded="false" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
        <span class="tool-chevron">&#9654;</span>
        <span class="tool-name">${escapeHtml(tool)}</span>
        ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}
        <span class="tool-status running">실행 중...</span>
      </div>
      <div class="tool-body">
        <div class="tool-terminal"><span class="term-prompt">${escapeHtml(tool.toLowerCase())} </span><span class="term-cmd">${escapeHtml(inputStr)}</span><span class="term-divider"></span><span class="term-output">⏳</span></div>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="tool-header" role="button" tabindex="0" aria-expanded="false" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
        <span class="tool-chevron">&#9654;</span>
        <span class="tool-name">${escapeHtml(tool)}</span>
        ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}
        <span class="tool-status running">실행 중...</span>
      </div>
      <div class="tool-body">
        <div class="tool-section">
          <div class="tool-label">입력</div>
          <div class="tool-input">${escapeHtml(inputStr)}</div>
        </div>
        <div class="tool-section">
          <div class="tool-label">결과</div>
          <div class="tool-output">대기 중...</div>
        </div>
      </div>
    `;
  }

  toolBlocks[id] = el;
  return el;
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `<div class="message-role ${role}">${role === "user" ? "You" : "Claude"}</div><div class="message-content">${text ? renderMarkdown(text) : ""}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block-wrapper">${langLabel}<button class="code-copy-btn" onclick="copyCode(this)">복사</button><pre><code class="language-${lang}">${code.trim()}</code></pre></div>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
    const ths = header.split("|").filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join("");
    const rows = body.trim().split("\n").map(row => {
      const tds = row.split("|").filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/((?:<oli>.*<\/oli>\n*)+)/g, (m) => "<ol>" + m.replace(/<\/?oli>/g, (t) => t.replace("oli", "li")) + "</ol>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  html = html.replace(/\n\n/g, "</p><p>");
  if (!html.startsWith("<")) html = "<p>" + html;
  if (!html.endsWith(">")) html += "</p>";

  html = html.replace(/<p><\/p>/g, "");
  const blockTags = ["h1","h2","h3","pre","ul","ol","table","blockquote","hr"];
  for (const t of blockTags) {
    html = html.replace(new RegExp(`<p>(<${t}>)`, "g"), "$1");
    html = html.replace(new RegExp(`(</${t}>)</p>`, "g"), "$1");
  }
  // hr is self-closing
  html = html.replace(/<p>(<hr>)/g, "$1");

  return html;
}

function showToast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function updateContextBar() {
  const bar = document.getElementById("context-bar");
  const fill = document.getElementById("context-fill");
  const label = document.getElementById("context-label");
  if (!lastInputTokens) { bar.style.display = "none"; document.querySelector("header").classList.remove("has-context-bar"); return; }
  bar.style.display = "flex";
  document.querySelector("header").classList.add("has-context-bar");
  const pct = Math.min((lastInputTokens / maxContext) * 100, 100);
  fill.style.width = pct + "%";
  fill.className = "context-bar-fill" + (pct > 75 ? " danger" : pct > 50 ? " warn" : "");

  // Token display: use M for 1M+ windows
  const usedK = Math.round(lastInputTokens / 1000);
  const maxStr = maxContext >= 1000000
    ? `${(maxContext / 1000000).toFixed(0)}M`
    : `${maxContext / 1000}K`;
  const turnStr = lastNumTurns > 0 ? ` · ${lastNumTurns} rounds` : "";
  label.textContent = `${usedK}K / ${maxStr}${turnStr}`;

  // Warning — remove old one first to prevent duplication
  const existingWarn = document.getElementById("context-warning");
  if (existingWarn) existingWarn.remove();
  if (pct > 75) {
    label.style.color = "var(--error)";
  } else if (pct > 50) {
    label.style.color = "var(--warning)";
  } else {
    label.style.color = "";
  }
}

function copyCode(btn) {
  const code = btn.closest(".code-block-wrapper").querySelector("code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "복사됨!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("copied"); }, 1500);
  });
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // Cmd/Ctrl+N: new chat
  if (mod && e.key === "n") { e.preventDefault(); newChatBtn.click(); }
  // Cmd/Ctrl+L: focus input
  if (mod && e.key === "l") { e.preventDefault(); inputEl.focus(); }
  // Cmd/Ctrl+Shift+S: toggle sidebar
  if (mod && e.shiftKey && e.key === "S") { e.preventDefault(); sidebarToggle.click(); }
  // Cmd/Ctrl+,: settings
  if (mod && e.key === ",") { e.preventDefault(); settingsBtn.click(); }
  // Escape: abort response or close modal/sidebar
  if (e.key === "Escape") {
    if (settingsModal.style.display === "flex") { settingsModal.style.display = "none"; }
    else if (sidebar.classList.contains("open")) { sidebar.classList.remove("open"); }
    else if (sending) { abortResponse(); }
  }
});

// --- Bookmark functions ---
function addBookmarkBtn(messageEl, text) {
  if (!text || !text.trim()) return;
  // Create a dedicated action bar below the message content
  const actionBar = document.createElement("div");
  actionBar.className = "message-actions";
  const btn = document.createElement("button");
  btn.className = "bookmark-btn";
  btn.title = "이 응답 북마크";
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg> <span>북마크</span>`;
  btn.addEventListener("click", async () => {
    const title = text.substring(0, 80).split("\n")[0];
    try {
      const resp = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, title, content: text }),
      });
      if (!resp.ok) throw new Error("Save failed");
      btn.classList.add("bookmarked");
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg> <span>저장됨</span>`;
      showToast("북마크에 저장했습니다", "success");
    } catch (e) {
      showToast("북마크 저장 실패", "error");
    }
  });
  actionBar.appendChild(btn);
  // Insert action bar after message-content, before message-meta
  const contentEl = messageEl.querySelector(".message-content");
  if (contentEl && contentEl.nextSibling) {
    messageEl.insertBefore(actionBar, contentEl.nextSibling);
  } else {
    messageEl.appendChild(actionBar);
  }
}

async function loadBookmarks() {
  convList.innerHTML = "";  // Clear immediately to avoid stale content
  try {
    const resp = await fetch("/api/bookmarks");
    if (!resp.ok) throw new Error("Failed to fetch bookmarks");
    const bookmarks = await resp.json();
    const filtered = searchQuery
      ? bookmarks.filter(b => b.title.toLowerCase().includes(searchQuery.toLowerCase()) || (b.content || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : bookmarks;
    if (filtered.length === 0) {
      convList.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">${searchQuery ? "검색 결과가 없습니다" : "저장된 북마크가 없어요"}</div>`;
      return;
    }
    for (const b of filtered) {
      const item = document.createElement("div");
      item.className = "conv-item bookmark-item";
      const date = new Date(b.created_at).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
      const preview = b.content ? b.content.substring(0, 60).replace(/\n/g, " ") + "…" : "";
      item.innerHTML = `
        <div class="conv-item-text">
          <div class="conv-item-title"><span class="bookmark-icon-star">&#9733;</span> ${escapeHtml(b.title)}</div>
          <div class="conv-item-preview">${escapeHtml(preview)}</div>
          <div class="conv-item-date">${date}</div>
        </div>
        <button class="conv-item-delete" title="삭제">&times;</button>
      `;
      item.querySelector(".conv-item-text").addEventListener("click", () => {
        messagesEl.innerHTML = "";
        addMessage("assistant", b.content);
        sidebar.classList.remove("open");
      });
      item.querySelector(".conv-item-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/api/bookmarks/${b.id}`, { method: "DELETE" });
        loadBookmarks();
      });
      convList.appendChild(item);
    }
  } catch (e) {
    console.error("Failed to load bookmarks:", e);
    convList.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">북마크를 불러올 수 없습니다</div>`;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
