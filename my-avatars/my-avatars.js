const AC2_ORIGIN = "https://geosephlien.github.io";
const AC2_BASE_PATH = "/viverse-avatar-creator";
const AC2_URL = `${AC2_ORIGIN}${AC2_BASE_PATH}/index.html?embedded=1&uiMode=modal`;
const API_BASE = "https://ac2-host-api.kuanyi-lien.workers.dev";
const FILE_POLL_INTERVAL_MS = 5000;
const MAX_FRAME_SIZE = 2000;
const MAX_FRAME_PADDING = 80;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_FRAME_STYLE = {
  source: "host-fallback",
  placement: "center",
  breakpoint: 960,
  panelWidth: 1280,
  panelHeight: 780,
  panelRadius: 28,
  mobilePanelWidth: null,
  mobilePanelHeight: 780,
  mobilePanelRadius: 22,
  padding: {
    top: 32,
    right: 32,
    bottom: 32,
    left: 32
  },
  mobilePadding: {
    top: 16,
    right: 0,
    bottom: 16,
    left: 0
  },
  backdrop: "rgba(4, 7, 20, 0.58)",
  backdropFilter: "blur(12px)",
  panelBackground: "rgba(11, 14, 40, 0.96)",
  frameBackground: "#050814",
  border: "1px solid rgba(255, 255, 255, 0.18)"
};
const openBtn = document.getElementById("open-ac2-btn");
const modal = document.getElementById("ac2-modal");
const frame = document.getElementById("ac2-frame");
const statusEl = document.getElementById("ac2-status");
const avatarList = document.getElementById("avatar-list");
const uploadDock = document.getElementById("ac2-upload-dock");
const uploadDockTitle = document.getElementById("ac2-upload-dock-title");
const uploadDockMessage = document.getElementById("ac2-upload-dock-message");
const uploadDockBar = document.getElementById("ac2-upload-dock-bar");
const uploadDockPercent = document.getElementById("ac2-upload-dock-percent");
const uploadDockDetail = document.getElementById("ac2-upload-dock-detail");

let ac2InitPayload = null;
let ac2RequestId = null;
let ac2Ready = false;
let ac2LaunchPending = false;
let filePollTimer = null;
let isLoadingFiles = false;
let lastFilesSignature = "";
let currentFrameStyle = normalizeFrameStyle(DEFAULT_FRAME_STYLE);
let launchFrameStyle = normalizeFrameStyle(DEFAULT_FRAME_STYLE);
let ac2UploadInProgress = false;
const hostSupportsExternalUploadDock = true;
let ac2UploadState = {
  active: false,
  failed: false,
  fileName: "avatar.vrm",
  loadedBytes: 0,
  totalBytes: 0,
  message: "Your avatar will be ready soon."
};
let ac2ExternalUploadPanelConfig = {
  enabled: false,
  title: "Preparing",
  message: "Your avatar will be ready soon.",
  gradient: "linear-gradient(102deg, #4f6df2, #7a67ea 50%, #b566d8)",
  background: "rgba(11, 14, 40, 0.96)",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  track: "rgba(255, 255, 255, 0.14)"
};

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

function toCssValue(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : fallback;
}

function normalizeFrameStyle(frameStyle) {
  const source = frameStyle || {};
  const allowedPlacements = new Set(["left", "center", "right", "top", "bottom", "fullscreen"]);
  const placement = allowedPlacements.has(source.placement) ? source.placement : DEFAULT_FRAME_STYLE.placement;

  return {
    placement,
    breakpoint: toBoundedNumber(source.breakpoint, DEFAULT_FRAME_STYLE.breakpoint, 320, 1440),
    panelWidth: toBoundedNumber(source.panelWidth, DEFAULT_FRAME_STYLE.panelWidth, 320, MAX_FRAME_SIZE),
    panelHeight: toBoundedNumber(source.panelHeight, DEFAULT_FRAME_STYLE.panelHeight, 320, MAX_FRAME_SIZE),
    panelRadius: toBoundedNumber(source.panelRadius, DEFAULT_FRAME_STYLE.panelRadius, 0, 48),
    mobilePanelWidth: source.mobilePanelWidth == null ? null : toBoundedNumber(source.mobilePanelWidth, DEFAULT_FRAME_STYLE.panelWidth, 280, MAX_FRAME_SIZE),
    mobilePanelHeight: source.mobilePanelHeight == null ? null : toBoundedNumber(source.mobilePanelHeight, DEFAULT_FRAME_STYLE.panelHeight, 280, MAX_FRAME_SIZE),
    mobilePanelRadius: toBoundedNumber(source.mobilePanelRadius, DEFAULT_FRAME_STYLE.mobilePanelRadius, 0, 32),
    padding: normalizePadding(source.padding, DEFAULT_FRAME_STYLE.padding),
    mobilePadding: normalizePadding(source.mobilePadding, DEFAULT_FRAME_STYLE.mobilePadding),
    backdrop: toCssValue(source.backdrop, DEFAULT_FRAME_STYLE.backdrop),
    backdropFilter: toCssValue(source.backdropFilter, DEFAULT_FRAME_STYLE.backdropFilter),
    panelBackground: toCssValue(source.panelBackground, DEFAULT_FRAME_STYLE.panelBackground),
    frameBackground: toCssValue(source.frameBackground, DEFAULT_FRAME_STYLE.frameBackground),
    border: toCssValue(source.border, DEFAULT_FRAME_STYLE.border),
    source: typeof source.source === "string" ? source.source : DEFAULT_FRAME_STYLE.source
  };
}

function updateViewportMetrics() {
  const viewport = window.visualViewport;
  const visualHeight = viewport ? viewport.height : window.innerHeight;
  const viewportHeight = Math.max(0, Math.round(visualHeight));
  let browserUiInset = 0;

  if (viewport) {
    browserUiInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  }

  document.documentElement.style.setProperty("--ac2-shell-viewport-height", `${viewportHeight}px`);
  document.documentElement.style.setProperty("--ac2-shell-mobile-browser-ui-inset", `${Math.round(browserUiInset)}px`);
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

function getUploadPercent() {
  if (!ac2UploadState.active) {
    return 0;
  }

  if (!Number.isFinite(ac2UploadState.totalBytes) || ac2UploadState.totalBytes <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((ac2UploadState.loadedBytes / ac2UploadState.totalBytes) * 100)));
}

function formatUploadBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function renderUploadDock() {
  if (!uploadDock) {
    return;
  }

  const shouldShow = hostSupportsExternalUploadDock &&
    ac2ExternalUploadPanelConfig.enabled &&
    ac2UploadState.active &&
    modal.hidden;

  uploadDock.hidden = !shouldShow;
  if (!shouldShow) {
    return;
  }

  const percent = getUploadPercent();
  uploadDock.style.setProperty("--ac2-upload-dock-gradient", ac2ExternalUploadPanelConfig.gradient);
  uploadDock.style.setProperty("--ac2-upload-dock-background", ac2ExternalUploadPanelConfig.background);
  uploadDock.style.setProperty("--ac2-upload-dock-border", ac2ExternalUploadPanelConfig.border);
  uploadDock.style.setProperty("--ac2-upload-dock-track", ac2ExternalUploadPanelConfig.track);

  if (uploadDockTitle) {
    uploadDockTitle.textContent = ac2ExternalUploadPanelConfig.title;
  }
  if (uploadDockMessage) {
    uploadDockMessage.textContent = ac2UploadState.failed
      ? ac2UploadState.message
      : ac2ExternalUploadPanelConfig.message;
  }
  if (uploadDockBar) {
    uploadDockBar.style.width = `${percent}%`;
  }
  if (uploadDockPercent) {
    uploadDockPercent.textContent = `${percent}%`;
  }
  if (uploadDockDetail) {
    uploadDockDetail.textContent = ac2UploadState.failed
      ? "Open AC2 to review."
      : `${formatUploadBytes(ac2UploadState.loadedBytes)} / ${formatUploadBytes(ac2UploadState.totalBytes)}`;
  }
}

function resetUploadState() {
  ac2UploadState = {
    active: false,
    failed: false,
    fileName: "avatar.vrm",
    loadedBytes: 0,
    totalBytes: 0,
    message: ac2ExternalUploadPanelConfig.message || "Your avatar will be ready soon."
  };
  renderUploadDock();
}

function applyExternalUploadPanelConfig(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  ac2ExternalUploadPanelConfig = {
    enabled: payload.enabled !== false,
    title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : ac2ExternalUploadPanelConfig.title,
    message: typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : ac2ExternalUploadPanelConfig.message,
    gradient: typeof payload.gradient === "string" && payload.gradient.trim() ? payload.gradient.trim() : ac2ExternalUploadPanelConfig.gradient,
    background: typeof payload.background === "string" && payload.background.trim() ? payload.background.trim() : ac2ExternalUploadPanelConfig.background,
    border: typeof payload.border === "string" && payload.border.trim() ? payload.border.trim() : ac2ExternalUploadPanelConfig.border,
    track: typeof payload.track === "string" && payload.track.trim() ? payload.track.trim() : ac2ExternalUploadPanelConfig.track
  };
  if (!ac2UploadState.failed) {
    ac2UploadState.message = ac2ExternalUploadPanelConfig.message;
  }
  renderUploadDock();
}

function restoreLaunchFrameStyle() {
  applyAc2FrameStyle(launchFrameStyle);
}

function notifyAc2UploadEvent(type, payload) {
  postMessageToAc2(type, payload || {});
}

function openModal() {
  restoreLaunchFrameStyle();
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderUploadDock();
}

function postMessageToAc2(type, payload) {
  if (!frame || !frame.contentWindow) {
    return false;
  }

  frame.contentWindow.postMessage({
    type,
    payload: payload || {}
  }, AC2_ORIGIN);
  return true;
}

function requestAc2Reset() {
  postMessageToAc2("avatar-creator-reset");
}

function closeModal() {
  ac2LaunchPending = false;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  restoreLaunchFrameStyle();
  renderUploadDock();
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
    ac2Ready = false;
    frame.src = AC2_URL;
    return false;
  }

  return true;
}

function applyAc2FrameStyle(frameStyle) {
  currentFrameStyle = normalizeFrameStyle(frameStyle);

  if (!modal) {
    return currentFrameStyle;
  }

  modal.dataset.shellPlacement = currentFrameStyle.placement;
  modal.dataset.shellMobile = String(window.innerWidth <= currentFrameStyle.breakpoint);
  modal.style.setProperty("--ac2-shell-breakpoint", `${currentFrameStyle.breakpoint}px`);
  modal.style.setProperty("--ac2-shell-width", `${currentFrameStyle.panelWidth}px`);
  modal.style.setProperty("--ac2-shell-height", `${currentFrameStyle.panelHeight}px`);
  modal.style.setProperty("--ac2-shell-radius", `${currentFrameStyle.panelRadius}px`);
  modal.style.setProperty("--ac2-shell-mobile-width", currentFrameStyle.mobilePanelWidth ? `${currentFrameStyle.mobilePanelWidth}px` : "var(--ac2-shell-width)");
  modal.style.setProperty("--ac2-shell-mobile-height", currentFrameStyle.mobilePanelHeight ? `${currentFrameStyle.mobilePanelHeight}px` : "var(--ac2-shell-height)");
  modal.style.setProperty("--ac2-shell-mobile-radius", `${currentFrameStyle.mobilePanelRadius}px`);
  modal.style.setProperty("--ac2-shell-backdrop", currentFrameStyle.backdrop);
  modal.style.setProperty("--ac2-shell-backdrop-filter", currentFrameStyle.backdropFilter);
  modal.style.setProperty("--ac2-shell-panel-background", currentFrameStyle.panelBackground);
  modal.style.setProperty("--ac2-shell-frame-background", currentFrameStyle.frameBackground);
  modal.style.setProperty("--ac2-shell-border", currentFrameStyle.border);
  modal.style.setProperty("--ac2-shell-padding-top", `${currentFrameStyle.padding.top}px`);
  modal.style.setProperty("--ac2-shell-padding-right", `${currentFrameStyle.padding.right}px`);
  modal.style.setProperty("--ac2-shell-padding-bottom", `${currentFrameStyle.padding.bottom}px`);
  modal.style.setProperty("--ac2-shell-padding-left", `${currentFrameStyle.padding.left}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-top", `${currentFrameStyle.mobilePadding.top}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-right", `${currentFrameStyle.mobilePadding.right}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-bottom", `${currentFrameStyle.mobilePadding.bottom}px`);
  modal.style.setProperty("--ac2-shell-mobile-padding-left", `${currentFrameStyle.mobilePadding.left}px`);

  updateViewportMetrics();
  return currentFrameStyle;
}

function applyFrameStyleFromMessage(message) {
  const frameStyle = message && message.payload && message.payload.frameStyle;
  if (!frameStyle || typeof frameStyle !== "object") {
    return false;
  }

  launchFrameStyle = normalizeFrameStyle(frameStyle);
  applyAc2FrameStyle(launchFrameStyle);
  return true;
}

function sendAc2Init() {
  if (!ac2Ready || !ac2InitPayload || !frame.contentWindow) {
    return;
  }

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
      locale: "zh-TW"
    }
  }, AC2_ORIGIN);

  setStatus("Initializing AC2...");
}

async function uploadVrmToBackend(file, options = {}) {
  await ensureAc2Session();

  const formData = new FormData();
  formData.append("file", file);
  const authHeaders = getAuthHeaders();

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE}/api/ac2/upload-vrm`, true);
    request.withCredentials = true;

    Object.entries(authHeaders).forEach(([key, value]) => {
      request.setRequestHeader(key, value);
    });

    request.upload.addEventListener("progress", (event) => {
      if (typeof options.onProgress === "function") {
        options.onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : file.size || 0
        });
      }
    });

    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`VRM upload failed (${request.status})`));
        return;
      }

      try {
        const payload = request.responseText ? JSON.parse(request.responseText) : {};
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });

    request.addEventListener("error", () => {
      reject(new Error("VRM upload failed."));
    });

    request.addEventListener("abort", () => {
      reject(new Error("VRM upload aborted."));
    });

    request.send(formData);
  });
}

function parsePayload(payload) {
  if (typeof payload !== "string") {
    return payload;
  }

  try {
    return JSON.parse(payload);
  } catch (error) {
    console.warn("Unable to parse AC2 payload JSON.", error);
    return null;
  }
}

function bytesFromBase64(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const base64 = value.includes(",") ? value.split(",").pop() : value;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesFromValue(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }

  if (typeof value === "string") {
    return bytesFromBase64(value);
  }

  return null;
}

function toVrmFile(payload) {
  payload = parsePayload(payload);

  if (payload && payload.file instanceof File) {
    return payload.file;
  }

  if (!payload || !payload.avatarBytes) {
    const fallbackBytes = bytesFromValue(payload && (
      payload.vrmBytes ||
      payload.bytes ||
      payload.avatarBase64 ||
      payload.vrmBase64 ||
      payload.base64 ||
      payload.dataUrl
    ));

    if (!fallbackBytes) {
      return null;
    }

    payload = {
      ...payload,
      avatarBytes: fallbackBytes
    };
  }

  const fileName = typeof payload.fileName === "string" && payload.fileName.trim()
    ? payload.fileName.trim()
    : "avatar.vrm";
  const contentType = payload.contentType || "model/vrm";
  const avatarBytes = bytesFromValue(payload.avatarBytes);

  if (!avatarBytes) {
    return null;
  }

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

async function launchAc2Modal() {
  try {
    ac2LaunchPending = true;
    ac2RequestId = crypto.randomUUID();
    restoreLaunchFrameStyle();
    setStatus("Requesting AC2 session...");
    openModal();

    await ensureAc2Session();
    const frameAlreadyLoaded = ensureFrameLoaded();
    if (frameAlreadyLoaded && ac2Ready) {
      sendAc2Init();
    }
  } catch (error) {
    console.error(error);
    setStatus("Unable to start AC2.");
  }
}

openBtn.addEventListener("click", () => {
  void launchAc2Modal();
});

if (uploadDock) {
  uploadDock.addEventListener("click", () => {
    void launchAc2Modal();
  });
}

window.addEventListener("resize", () => {
  applyAc2FrameStyle(currentFrameStyle);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    applyAc2FrameStyle(currentFrameStyle);
  });
  window.visualViewport.addEventListener("scroll", () => {
    applyAc2FrameStyle(currentFrameStyle);
  });
}

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
    applyFrameStyleFromMessage(message);
    setStatus("AC2 ready.");
    if (ac2LaunchPending || !modal.hidden) {
      sendAc2Init();
    }
    return;
  }

  if (message.type === "ac2:init-ack") {
    ac2LaunchPending = false;
    applyFrameStyleFromMessage(message);
    setStatus("AC2 initialized.");
    return;
  }

  if (message.type === "ac2:ui-config") {
    applyFrameStyleFromMessage(message);
    return;
  }

  if (message.type === "ac2:external-upload-panel-config") {
    applyExternalUploadPanelConfig(message.payload);
    return;
  }

  if (message.type === "ac2:close-request") {
    if (message.payload && message.payload.reason === "upload-hidden") {
      setStatus("Upload in progress.");
    } else if (!message.payload || message.payload.reason !== "upload-complete") {
      setStatus("AC2 closed.");
    }
    closeModal();
    return;
  }

  if (message.type === "ac2:upload-vrm") {
    try {
      const file = message.payload && message.payload.file;
      if (!file) {
        throw new Error("Missing VRM file.");
      }

      ac2UploadInProgress = true;
      ac2UploadState.active = true;
      ac2UploadState.failed = false;
      ac2UploadState.fileName = file.name || "avatar.vrm";
      ac2UploadState.loadedBytes = 0;
      ac2UploadState.totalBytes = file.size || 0;
      ac2UploadState.message = ac2ExternalUploadPanelConfig.message;
      renderUploadDock();
      notifyAc2UploadEvent("ac2:upload-started", {
        fileName: file.name || "avatar.vrm",
        totalBytes: file.size || 0
      });
      const uploadResult = await uploadVrmToBackend(file, {
        onProgress(progress) {
          ac2UploadState.active = true;
          ac2UploadState.loadedBytes = progress.loaded;
          ac2UploadState.totalBytes = progress.total || file.size || 0;
          renderUploadDock();
          notifyAc2UploadEvent("ac2:upload-progress", {
            fileName: file.name || "avatar.vrm",
            loadedBytes: progress.loaded,
            totalBytes: progress.total || file.size || 0
          });
        }
      });
      console.log("AC2 upload-vrm result", uploadResult);
      ac2UploadInProgress = false;
      resetUploadState();
      setStatus("VRM uploaded.");
      notifyAc2UploadEvent("ac2:upload-complete", uploadResult);
      await loadVrmList({ force: true });
    } catch (error) {
      console.error(error);
      ac2UploadInProgress = false;
      ac2UploadState.active = true;
      ac2UploadState.failed = true;
      ac2UploadState.message = error && error.message ? error.message : "VRM upload failed.";
      renderUploadDock();
      notifyAc2UploadEvent("ac2:upload-failed", {
        message: error && error.message ? error.message : "VRM upload failed."
      });
      setStatus("VRM upload failed.");
    }
    return;
  }

  if (message.type === "ac2:avatar-created") {
    console.log("AC2 avatar-created", message.payload);
    try {
      const vrmFile = toVrmFile(message.payload);

      if (vrmFile) {
        ac2UploadInProgress = true;
        ac2UploadState.active = true;
        ac2UploadState.failed = false;
        ac2UploadState.fileName = vrmFile.name || "avatar.vrm";
        ac2UploadState.loadedBytes = 0;
        ac2UploadState.totalBytes = vrmFile.size || 0;
        ac2UploadState.message = ac2ExternalUploadPanelConfig.message;
        renderUploadDock();
        notifyAc2UploadEvent("ac2:upload-started", {
          fileName: vrmFile.name || "avatar.vrm",
          totalBytes: vrmFile.size || 0
        });
        const uploadResult = await uploadVrmToBackend(vrmFile, {
          onProgress(progress) {
            ac2UploadState.active = true;
            ac2UploadState.loadedBytes = progress.loaded;
            ac2UploadState.totalBytes = progress.total || vrmFile.size || 0;
            renderUploadDock();
            notifyAc2UploadEvent("ac2:upload-progress", {
              fileName: vrmFile.name || "avatar.vrm",
              loadedBytes: progress.loaded,
              totalBytes: progress.total || vrmFile.size || 0
            });
          }
        });
        console.log("AC2 avatar upload result", uploadResult);
        ac2UploadInProgress = false;
        resetUploadState();
        setStatus("VRM uploaded.");
        notifyAc2UploadEvent("ac2:upload-complete", uploadResult);
        await loadVrmList({ force: true });
      } else {
        setStatus("Avatar created.");
      }
    } catch (error) {
      console.error(error);
      ac2UploadInProgress = false;
      ac2UploadState.active = true;
      ac2UploadState.failed = true;
      ac2UploadState.message = error && error.message ? error.message : "VRM upload failed.";
      renderUploadDock();
      notifyAc2UploadEvent("ac2:upload-failed", {
        message: error && error.message ? error.message : "VRM upload failed."
      });
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
renderUploadDock();
startFilePolling();
ensureAc2Session()
  .then(() => loadVrmList({ force: true }))
  .catch((error) => {
    console.error(error);
    setStatus("Unable to start avatar session.");
  });
