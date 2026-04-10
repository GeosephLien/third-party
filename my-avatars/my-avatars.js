const AC2_ORIGIN = "https://geosephlien.github.io";
const AC2_BASE_PATH = "/viverse-avatar-creator";
const AC2_URL = `${AC2_ORIGIN}${AC2_BASE_PATH}/index.html?embedded=1&uiMode=modal`;
const API_BASE = "https://ac2-host-api.kuanyi-lien.workers.dev";
const FILE_POLL_INTERVAL_MS = 5000;
const MOBILE_BREAKPOINT = 720;
const MAX_FRAME_SIZE = 2000;
const MAX_FRAME_PADDING = 80;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_FRAME_STYLE = {
  placement: "center",
  panelWidth: 1280,
  panelHeight: 860,
  panelRadius: 24,
  mobilePanelWidth: null,
  mobilePanelHeight: null,
  mobilePanelRadius: 18,
  padding: {
    top: 12,
    right: 12,
    bottom: 12,
    left: 12
  },
  mobilePadding: {
    top: 4,
    right: 4,
    bottom: 4,
    left: 4
  }
};

const openBtn = document.getElementById("open-ac2-btn");
const closeBtn = document.getElementById("ac2-close-btn");
const modal = document.getElementById("ac2-modal");
const backdrop = document.querySelector("[data-close-ac2]");
const dialog = document.querySelector(".ac2-dialog");
const frame = document.getElementById("ac2-frame");
const statusEl = document.getElementById("ac2-status");
const avatarList = document.getElementById("avatar-list");

let ac2InitPayload = null;
let ac2RequestId = null;
let ac2Ready = false;
let ac2LaunchPending = false;
let filePollTimer = null;
let isLoadingFiles = false;
let lastFilesSignature = "";
let currentFrameStyle = normalizeFrameStyle(DEFAULT_FRAME_STYLE);

function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(Math.max(numeric, min), max);
}

function normalizePadding(padding, fallback) {
  const source = padding || fallback;
  return {
    top: toBoundedNumber(source && source.top, fallback.top, 0, MAX_FRAME_PADDING),
    right: toBoundedNumber(source && source.right, fallback.right, 0, MAX_FRAME_PADDING),
    bottom: toBoundedNumber(source && source.bottom, fallback.bottom, 0, MAX_FRAME_PADDING),
    left: toBoundedNumber(source && source.left, fallback.left, 0, MAX_FRAME_PADDING)
  };
}

function normalizeFrameStyle(frameStyle) {
  const source = frameStyle || {};
  const allowedPlacements = new Set(["left", "center", "right"]);
  const placement = allowedPlacements.has(source.placement) ? source.placement : DEFAULT_FRAME_STYLE.placement;

  return {
    placement,
    panelWidth: toBoundedNumber(source.panelWidth, DEFAULT_FRAME_STYLE.panelWidth, 320, MAX_FRAME_SIZE),
    panelHeight: toBoundedNumber(source.panelHeight, DEFAULT_FRAME_STYLE.panelHeight, 320, MAX_FRAME_SIZE),
    panelRadius: toBoundedNumber(source.panelRadius, DEFAULT_FRAME_STYLE.panelRadius, 0, 48),
    mobilePanelWidth: source.mobilePanelWidth == null ? null : toBoundedNumber(source.mobilePanelWidth, DEFAULT_FRAME_STYLE.panelWidth, 280, MAX_FRAME_SIZE),
    mobilePanelHeight: source.mobilePanelHeight == null ? null : toBoundedNumber(source.mobilePanelHeight, DEFAULT_FRAME_STYLE.panelHeight, 280, MAX_FRAME_SIZE),
    mobilePanelRadius: toBoundedNumber(source.mobilePanelRadius, DEFAULT_FRAME_STYLE.mobilePanelRadius, 0, 32),
    padding: normalizePadding(source.padding, DEFAULT_FRAME_STYLE.padding),
    mobilePadding: normalizePadding(source.mobilePadding, DEFAULT_FRAME_STYLE.mobilePadding)
  };
}

function getCurrentUserId() {
  return ac2InitPayload && ac2InitPayload.userId ? ac2InitPayload.userId : "demo-user-001";
}

function getSessionToken() {
  return ac2InitPayload && ac2InitPayload.sessionToken ? ac2InitPayload.sessionToken : "";
}

function getAuthHeaders(extraHeaders = {}) {
  const token = getSessionToken();
  return token
    ? { ...extraHeaders, Authorization: `Bearer ${token}` }
    : extraHeaders;
}

function setStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function openModal() {
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function buildFilesSignature(files) {
  return JSON.stringify((files || []).map((file) => [file.key, file.size, file.uploadedAt]));
}

async function fetchAc2Session() {
  const response = await fetch(`${API_BASE}/api/ac2/session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "my-avatars"
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create AC2 session (${response.status})`);
  }

  return response.json();
}

async function ensureAc2Session() {
  if (ac2InitPayload && ac2InitPayload.sessionToken) {
    return ac2InitPayload;
  }

  ac2InitPayload = await fetchAc2Session();
  return ac2InitPayload;
}

async function fetchVrmFiles() {
  await ensureAc2Session();

  const response = await fetch(`${API_BASE}/api/ac2/files?userId=${encodeURIComponent(getCurrentUserId())}`, {
    method: "GET",
    headers: getAuthHeaders(),
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch VRM files (${response.status})`);
  }

  return response.json();
}

async function fetchDownloadUrl(key) {
  await ensureAc2Session();

  const response = await fetch(`${API_BASE}/api/ac2/download-url?key=${encodeURIComponent(key)}`, {
    method: "GET",
    headers: getAuthHeaders(),
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Failed to create download URL (${response.status})`);
  }

  return response.json();
}

async function deleteVrm(key) {
  await ensureAc2Session();

  const response = await fetch(`${API_BASE}/api/ac2/delete-vrm`, {
    method: "POST",
    credentials: "include",
    headers: getAuthHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      key
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to delete VRM (${response.status})`);
  }

  return response.json();
}

function triggerBrowserDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function ensureFrameLoaded() {
  if (frame.src !== AC2_URL) {
    frame.src = AC2_URL;
  }
}

function applyAc2FrameStyle(frameStyle) {
  currentFrameStyle = normalizeFrameStyle(frameStyle);

  if (!modal) {
    return currentFrameStyle;
  }

  modal.dataset.shellPlacement = currentFrameStyle.placement;
  modal.style.setProperty("--ac2-shell-width", `${currentFrameStyle.panelWidth}px`);
  modal.style.setProperty("--ac2-shell-height", `${currentFrameStyle.panelHeight}px`);
  modal.style.setProperty("--ac2-shell-radius", `${currentFrameStyle.panelRadius}px`);
  modal.style.setProperty("--ac2-shell-mobile-width", currentFrameStyle.mobilePanelWidth ? `${currentFrameStyle.mobilePanelWidth}px` : "var(--ac2-shell-width)");
  modal.style.setProperty("--ac2-shell-mobile-height", currentFrameStyle.mobilePanelHeight ? `${currentFrameStyle.mobilePanelHeight}px` : "var(--ac2-shell-height)");
  modal.style.setProperty("--ac2-shell-mobile-radius", `${currentFrameStyle.mobilePanelRadius}px`);
  modal.style.setProperty("--ac2-shell-backdrop", "transparent");
  modal.style.setProperty("--ac2-shell-padding-top", `${currentFrameStyle.padding.top}px`);
  modal.style.setProperty("--ac2-shell-padding-right", `${currentFrameStyle.padding.right}px`);
  modal.style.setProperty("--ac2-shell-padding-bottom", `${currentFrameStyle.padding.bottom}px`);
  modal.style.setProperty("--ac2-shell-padding-left", `${currentFrameStyle.padding.left}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-top", `${currentFrameStyle.mobilePadding.top}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-right", `${currentFrameStyle.mobilePadding.right}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-bottom", `${currentFrameStyle.mobilePadding.bottom}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-left", `${currentFrameStyle.mobilePadding.left}px`);

  return currentFrameStyle;
}

function sendAc2Init() {
  if (!ac2Ready || !ac2InitPayload || !frame.contentWindow) {
    return;
  }

  const frameStyle = applyAc2FrameStyle(currentFrameStyle);

  frame.contentWindow.postMessage({
    type: "ac2:init",
    protocol: "ac2",
    version: "1.0",
    requestId: ac2RequestId,
    payload: {
      sessionToken: ac2InitPayload.sessionToken,
      clientId: ac2InitPayload.clientId,
      userId: ac2InitPayload.userId,
      exp: ac2InitPayload.exp,
      uiMode: "modal",
      locale: "zh-TW",
      frameStyle
    }
  }, AC2_ORIGIN);

  setStatus("Initializing AC2...");
}

async function uploadVrmToBackend(file) {
  await ensureAc2Session();

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE}/api/ac2/upload-vrm`, {
    method: "POST",
    body: formData,
    headers: getAuthHeaders(),
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`VRM upload failed (${response.status})`);
  }

  return response.json();
}

function toVrmFile(payload) {
  if (!payload || !payload.avatarBytes) {
    return null;
  }

  const fileName = typeof payload.fileName === "string" && payload.fileName.trim()
    ? payload.fileName.trim()
    : "avatar.vrm";
  const contentType = payload.contentType || "model/vrm";
  const avatarBytes = payload.avatarBytes instanceof Uint8Array
    ? payload.avatarBytes
    : new Uint8Array(payload.avatarBytes);

  if (avatarBytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("VRM file is too large.");
  }

  return new File([avatarBytes], fileName, { type: contentType });
}

function clearAvatarList() {
  while (avatarList && avatarList.firstChild) {
    avatarList.firstChild.remove();
  }
}

function createAvatarCard(file) {
  const article = document.createElement("article");
  article.className = "avatar-card";

  const thumb = document.createElement("div");
  thumb.className = "avatar-thumb";

  const copy = document.createElement("div");
  copy.className = "avatar-copy";

  const name = document.createElement("strong");
  name.textContent = file.fileName || "avatar.vrm";

  const uploadedAt = document.createElement("span");
  const uploadedDate = new Date(file.uploadedAt);
  uploadedAt.textContent = Number.isNaN(uploadedDate.getTime())
    ? "Upload time unavailable"
    : uploadedDate.toLocaleString();

  const actions = document.createElement("div");
  actions.className = "avatar-actions";

  const downloadButton = document.createElement("button");
  downloadButton.className = "download-button";
  downloadButton.type = "button";
  downloadButton.dataset.downloadKey = file.key || "";
  downloadButton.textContent = "Download";

  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.type = "button";
  deleteButton.dataset.deleteKey = file.key || "";
  deleteButton.textContent = "Delete";

  copy.append(name, uploadedAt);
  actions.append(downloadButton, deleteButton);
  article.append(thumb, copy, actions);

  return article;
}

function renderEmptyState() {
  clearAvatarList();

  const article = document.createElement("article");
  article.className = "avatar-card placeholder";

  const thumb = document.createElement("div");
  thumb.className = "avatar-thumb";

  const copy = document.createElement("div");
  copy.className = "avatar-copy";

  const title = document.createElement("strong");
  title.textContent = "No avatars yet";

  const message = document.createElement("span");
  message.textContent = "Create one with AC2.";

  copy.append(title, message);
  article.append(thumb, copy);
  avatarList.append(article);
}

function renderVrmList(files) {
  if (!avatarList) {
    return;
  }

  if (!files || files.length === 0) {
    renderEmptyState();
    return;
  }

  clearAvatarList();

  const fragment = document.createDocumentFragment();
  files.forEach((file) => {
    fragment.append(createAvatarCard(file));
  });
  avatarList.append(fragment);
}

async function loadVrmList(options = {}) {
  if (isLoadingFiles) {
    return;
  }

  try {
    isLoadingFiles = true;
    const result = await fetchVrmFiles();
    const files = result.files || [];
    const signature = buildFilesSignature(files);

    if (options.force || signature !== lastFilesSignature) {
      lastFilesSignature = signature;
      renderVrmList(files);
    }
  } catch (error) {
    console.error(error);
    setStatus("Unable to load avatars.");
  } finally {
    isLoadingFiles = false;
  }
}

function startFilePolling() {
  if (filePollTimer) {
    return;
  }

  filePollTimer = window.setInterval(() => {
    if (document.hidden) {
      return;
    }

    void loadVrmList();
  }, FILE_POLL_INTERVAL_MS);
}

openBtn.addEventListener("click", async () => {
  try {
    ac2Ready = false;
    ac2LaunchPending = true;
    ac2RequestId = crypto.randomUUID();
    applyAc2FrameStyle(currentFrameStyle);
    setStatus("Requesting AC2 session...");
    openModal();

    await ensureAc2Session();
    ensureFrameLoaded();
  } catch (error) {
    console.error(error);
    setStatus("Unable to start AC2.");
  }
});

if (closeBtn) {
  closeBtn.addEventListener("click", closeModal);
}
if (backdrop) {
  backdrop.addEventListener("click", closeModal);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) {
    closeModal();
  }
});

window.addEventListener("resize", () => {
  applyAc2FrameStyle(currentFrameStyle);
});

window.addEventListener("message", async (event) => {
  if (event.origin !== AC2_ORIGIN) {
    return;
  }

  const message = event.data || {};
  if (!message.type) {
    return;
  }

  if (message.type === "ac2:ready") {
    ac2Ready = true;
    setStatus("AC2 ready.");
    if (ac2LaunchPending) {
      sendAc2Init();
    }
    return;
  }

  if (message.type === "ac2:init-ack") {
    setStatus("AC2 initialized.");
    return;
  }

  if (message.type === "ac2:close-request") {
    setStatus("AC2 closed.");
    closeModal();
    return;
  }

  if (message.type === "ac2:upload-vrm") {
    try {
      setStatus("Uploading VRM...");
      const file = message.payload && message.payload.file;
      if (!file) {
        throw new Error("Missing VRM file.");
      }

      const uploadResult = await uploadVrmToBackend(file);
      console.log("AC2 upload-vrm result", uploadResult);
      setStatus("VRM uploaded.");
      closeModal();
      await loadVrmList({ force: true });
    } catch (error) {
      console.error(error);
      setStatus("VRM upload failed.");
    }
    return;
  }

  if (message.type === "ac2:avatar-created") {
    console.log("AC2 avatar-created", message.payload);
    try {
      const vrmFile = toVrmFile(message.payload);

      if (vrmFile) {
        setStatus("Uploading VRM...");
        const uploadResult = await uploadVrmToBackend(vrmFile);
        console.log("AC2 avatar upload result", uploadResult);
        setStatus("VRM uploaded.");
        closeModal();
        await loadVrmList({ force: true });
      } else {
        setStatus("Avatar created.");
      }
    } catch (error) {
      console.error(error);
      setStatus("VRM upload failed.");
    }
    return;
  }

  if (message.type === "ac2:export-ready") {
    console.log("AC2 export-ready", message.payload);
    setStatus("Export ready.");
    return;
  }

  if (message.type === "ac2:error" || message.type === "ac2:blocked") {
    console.error("AC2 error", message.payload);
    setStatus(message.payload && (message.payload.message || message.payload.detail) || "AC2 error.");
  }
});

if (avatarList) {
  avatarList.addEventListener("click", async (event) => {
    const downloadButton = event.target.closest("[data-download-key]");
    if (downloadButton) {
      const key = downloadButton.dataset.downloadKey;
      if (!key) {
        return;
      }

      try {
        downloadButton.disabled = true;
        const result = await fetchDownloadUrl(key);
        if (result && result.url) {
          triggerBrowserDownload(result.url);
        }
      } catch (error) {
        console.error(error);
        setStatus("Unable to prepare download.");
      } finally {
        downloadButton.disabled = false;
      }
      return;
    }

    const deleteButton = event.target.closest("[data-delete-key]");
    if (!deleteButton) {
      return;
    }

    const key = deleteButton.dataset.deleteKey;
    if (!key) {
      return;
    }

    try {
      deleteButton.disabled = true;
      await deleteVrm(key);
      await loadVrmList({ force: true });
      setStatus("Avatar deleted.");
    } catch (error) {
      console.error(error);
      setStatus("Unable to delete avatar.");
    } finally {
      deleteButton.disabled = false;
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void loadVrmList();
  }
});

applyAc2FrameStyle(DEFAULT_FRAME_STYLE);
startFilePolling();
ensureAc2Session()
  .then(() => loadVrmList({ force: true }))
  .catch((error) => {
    console.error(error);
    setStatus("Unable to start avatar session.");
  });
