const AC2_ORIGIN = "https://geosephlien.github.io/viverse-avatar-creator";
const AC2_URL = `${AC2_ORIGIN}/index.html?embedded=1&uiMode=modal`;

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

function setStatus(text) {
  statusEl.textContent = text;
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

async function fetchAc2Session() {
  const response = await fetch("/api/ac2/session", {
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
      autoStart: true
    }
  }, AC2_ORIGIN);

  setStatus("Initializing AC2...");
}

async function uploadVrmToBackend(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/ac2/upload-vrm", {
    method: "POST",
    body: formData,
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`VRM upload failed (${response.status})`);
  }

  return response.json();
}

function appendAvatarCard(payload) {
  const card = document.createElement("article");
  card.className = "avatar-card";
  card.innerHTML = `
    <div class="avatar-thumb"></div>
    <div class="avatar-copy">
      <strong>${payload.name || "New Avatar"}</strong>
      <span>${payload.message || "Created via AC2"}</span>
    </div>
  `;

  const placeholder = avatarList.querySelector(".placeholder");
  if (placeholder) {
    placeholder.remove();
  }

  avatarList.prepend(card);
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

closeBtn.addEventListener("click", closeModal);
backdrop.addEventListener("click", closeModal);

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

      await uploadVrmToBackend(file);
      setStatus("VRM uploaded.");
    } catch (error) {
      console.error(error);
      setStatus("VRM upload failed.");
    }
    return;
  }

  if (message.type === "ac2:avatar-created") {
    setStatus("Avatar created.");
    appendAvatarCard({
      name: "Avatar Draft",
      message: "AC2 reported avatar-created."
    });
    return;
  }

  if (message.type === "ac2:export-ready") {
    setStatus("Export ready.");
    console.log("AC2 export-ready", message.payload);
    return;
  }

  if (message.type === "ac2:error" || message.type === "ac2:blocked") {
    console.error("AC2 error", message.payload);
    setStatus(message.payload && (message.payload.message || message.payload.detail) || "AC2 error.");
  }
});

