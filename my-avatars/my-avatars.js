const AC2_ORIGIN = "https://geosephlien.github.io";
const AC2_BASE_PATH = "/viverse-avatar-creator";
const AC2_URL = `${AC2_ORIGIN}${AC2_BASE_PATH}/index.html?embedded=1&uiMode=modal`;
const API_BASE = "https://ac2-host-api.kuanyi-lien.workers.dev";
const FILE_POLL_INTERVAL_MS = 5000;

const openBtn = document.getElementById("open-ac2-btn");
const closeBtn = document.getElementById("ac2-close-btn");
const modal = document.getElementById("ac2-modal");
const backdrop = document.querySelector("[data-close-ac2]");
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

function getCurrentUserId() {
  return ac2InitPayload && ac2InitPayload.userId ? ac2InitPayload.userId : "demo-user-001";
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

async function fetchVrmFiles() {
  const response = await fetch(`${API_BASE}/api/ac2/files?userId=${encodeURIComponent(getCurrentUserId())}`, {
    method: "GET",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch VRM files (${response.status})`);
  }

  return response.json();
}

async function fetchDownloadUrl(key) {
  const response = await fetch(`${API_BASE}/api/ac2/download-url?key=${encodeURIComponent(key)}`, {
    method: "GET",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Failed to create download URL (${response.status})`);
  }

  return response.json();
}

async function deleteVrm(key) {
  const response = await fetch(`${API_BASE}/api/ac2/delete-vrm`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      key,
      userId: getCurrentUserId()
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
      locale: "zh-TW",
      frameStyle: {
        placement: "center",
        panelWidth: 1280,
        panelHeight: 860,
        panelRadius: 24,
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
      }
    }
  }, AC2_ORIGIN);

  setStatus("Initializing AC2...");
}

async function uploadVrmToBackend(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("userId", getCurrentUserId());

  const response = await fetch(`${API_BASE}/api/ac2/upload-vrm`, {
    method: "POST",
    body: formData,
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

  const fileName = payload.fileName || "avatar.vrm";
  const contentType = payload.contentType || "model/vrm";
  const avatarBytes = payload.avatarBytes instanceof Uint8Array
    ? payload.avatarBytes
    : new Uint8Array(payload.avatarBytes);

  return new File([avatarBytes], fileName, { type: contentType });
}

function renderVrmList(files) {
  if (!avatarList) {
    return;
  }

  if (!files || files.length === 0) {
    avatarList.innerHTML = `
      <article class="avatar-card placeholder">
        <div class="avatar-thumb"></div>
        <div class="avatar-copy">
          <strong>No avatars yet</strong>
          <span>Create one with AC2.</span>
        </div>
      </article>
    `;
    return;
  }

  avatarList.innerHTML = files.map((file) => `
    <article class="avatar-card">
      <div class="avatar-thumb"></div>
      <div class="avatar-copy">
        <strong>${file.fileName}</strong>
        <span>${new Date(file.uploadedAt).toLocaleString()}</span>
      </div>
      <div class="avatar-actions">
        <button class="download-button" type="button" data-download-key="${file.key}">Download</button>
        <button class="delete-button" type="button" data-delete-key="${file.key}">Delete</button>
      </div>
    </article>
  `).join("");
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

function stopFilePolling() {
  if (!filePollTimer) {
    return;
  }

  window.clearInterval(filePollTimer);
  filePollTimer = null;
}

openBtn.addEventListener("click", async () => {
  try {
    ac2Ready = false;
    ac2LaunchPending = true;
    ac2RequestId = crypto.randomUUID();
    setStatus("Requesting AC2 session...");
    openModal();

    ac2InitPayload = await fetchAc2Session();
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
      try {
        const result = await fetchDownloadUrl(downloadButton.dataset.downloadKey);
        if (result && result.url) {
          triggerBrowserDownload(result.url);
        }
      } catch (error) {
        console.error(error);
      }
      return;
    }

    const deleteButton = event.target.closest("[data-delete-key]");
    if (!deleteButton) {
      return;
    }

    try {
      await deleteVrm(deleteButton.dataset.deleteKey);
      await loadVrmList({ force: true });
    } catch (error) {
      console.error(error);
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void loadVrmList();
  }
});

startFilePolling();
loadVrmList({ force: true });
