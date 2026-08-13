const $ = (id) => document.getElementById(id);

const p2pHome = $("p2pHome");
const p2pWait = $("p2pWait");
const p2pActive = $("p2pActive");
const createBtn = $("createBtn");
const joinBtn = $("joinBtn");
const roomInput = $("roomInput");
const roleLabel = $("roleLabel");
const waitLink = $("waitLink");
const copyWait = $("copyWait");
const statusText = $("statusText");
const filesDrop = $("filesDrop");
const p2pFileInput = $("p2pFileInput");
const p2pFilePanel = $("p2pFilePanel");
const p2pFileList = $("p2pFileList");
const sendBtn = $("sendBtn");
const sendProgressWrap = $("sendProgressWrap");
const sendBar = $("sendBar");
const sendText = $("sendText");
const sendDetail = $("sendDetail");
const recvProgressWrap = $("recvProgressWrap");
const recvBar = $("recvBar");
const recvText = $("recvText");
const recvDetail = $("recvDetail");
const sendPanel = $("sendPanel");
const toasts = $("toasts");

const CHUNK_SIZE = 64 * 1024;
const HEADER_SIZE = 12;
const ICE_SERVERS = window.ICE_SERVERS || [];
const BUFFER_LOW = 8 * 1024 * 1024;

let isHost = false;
let roomCode = "";
let myId = "";
let peerId = "";
let ws = null;
let pc = null;
let dc = null;
let sendQueue = [];
let sending = false;
let sentBytes = 0;
let sendTotal = 0;
const recvState = { files: [], buffers: [], received: 0, total: 0, lastProg: 0 };

const icons = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

function formatSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function makeId(len) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function extractRoom(value) {
  value = (value || "").trim();
  const q = value.match(/[?&#]room=([A-Za-z0-9_-]+)/i);
  if (q) return q[1];
  const last = value.split("/").pop().split(/[?#\s]/)[0];
  return last && last.length >= 4 ? last : "";
}

function toast(message, type = "success") {
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = (type === "success" ? icons.check : icons.alert) + "<span>" + message + "</span>";
  toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 260);
  }, 2600);
}

function status(msg) {
  if (statusText) statusText.textContent = msg;
}

/* ---------- file picking (sender) ---------- */
function addSendFiles(list) {
  for (const f of list) {
    if (!sendQueue.some((x) => x.name === f.name && x.size === f.size)) sendQueue.push(f);
  }
  renderSendFiles();
}

function renderSendFiles() {
  p2pFilePanel.classList.toggle("hidden", sendQueue.length === 0);
  p2pFileList.innerHTML = "";
  sendQueue.forEach((f, i) => {
    const li = document.createElement("li");
    const iconEl = document.createElement("span");
    iconEl.className = "file-type";
    iconEl.innerHTML = icons.file;
    const meta = document.createElement("span");
    meta.className = "f-meta";
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = f.name;
    name.title = f.name;
    const size = document.createElement("span");
    size.className = "fsize";
    size.textContent = formatSize(f.size);
    meta.append(name, size);
    const rm = document.createElement("button");
    rm.className = "rm-btn";
    rm.innerHTML = icons.x;
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      sendQueue.splice(i, 1);
      renderSendFiles();
    });
    li.append(iconEl, meta, rm);
    p2pFileList.appendChild(li);
  });
  sendBtn.disabled = sendQueue.length === 0 || !dc || dc.readyState !== "open";
}

filesDrop.addEventListener("click", () => p2pFileInput.click());
filesDrop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p2pFileInput.click(); }
});
filesDrop.addEventListener("dragover", (e) => { e.preventDefault(); filesDrop.classList.add("dragover"); });
filesDrop.addEventListener("dragleave", () => filesDrop.classList.remove("dragover"));
filesDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  filesDrop.classList.remove("dragover");
  addSendFiles(e.dataTransfer.files);
});
p2pFileInput.addEventListener("change", () => { addSendFiles(p2pFileInput.files); p2pFileInput.value = ""; });

/* ---------- WebRTC ---------- */
function setupRTC() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate && peerId && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "signal", to: peerId, signal: { type: "ice", candidate: e.candidate } }));
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      status("Direct link established");
    } else if (pc.connectionState === "failed") {
      status("Direct link failed — try the same network, or set up a TURN server");
    } else if (pc.connectionState === "disconnected") {
      status("Direct link lost");
    }
  };
  if (isHost) {
    dc = pc.createDataChannel("sendbox");
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => onChannelMessage(ev);
    dc.onopen = () => {
      status("Receiver connected — direct link ready");
      p2pWait.classList.add("hidden");
      p2pActive.classList.remove("hidden");
      renderSendFiles();
    };
    dc.onclose = () => status("Transfer channel closed");
  } else {
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.binaryType = "arraybuffer";
      dc.onmessage = (ev) => onChannelMessage(ev);
      dc.onopen = () => status("Direct link established");
      dc.onclose = () => status("Transfer channel closed");
    };
  }
}

function handleSignal(data) {
  if (data.type === "error") {
    if (data.message === "room-full") toast("This session already has two people", "error");
    return;
  }
  if (data.type === "room-state") {
    const others = (data.peers || []).filter((p) => p !== myId);
    if (others.length) peerId = others[0];
    return;
  }
  if (data.type === "peer-joined") {
    if (data.peerId === myId) return;
    peerId = data.peerId;
    status("Peer connected — establishing direct link…");
    if (isHost && pc && pc.signalingState === "stable") {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          ws.send(JSON.stringify({ type: "signal", to: peerId, signal: { type: "offer", sdp: pc.localDescription.sdp } }));
        })
        .catch(() => status("Could not create the connection"));
    }
    return;
  }
  if (data.type === "signal") {
    peerId = data.from || peerId;
    handleRTCMessage(data.signal);
    return;
  }
  if (data.type === "peer-left") {
    status("Peer disconnected");
    peerId = "";
  }
}

function handleRTCMessage(signal) {
  if (signal.type === "offer") {
    pc.setRemoteDescription({ type: "offer", sdp: signal.sdp })
      .then(() => pc.createAnswer())
      .then((ans) => pc.setLocalDescription(ans))
      .then(() => {
        ws.send(JSON.stringify({ type: "signal", to: peerId, signal: { type: "answer", sdp: pc.localDescription.sdp } }));
      })
      .catch(() => status("Could not accept the connection"));
  } else if (signal.type === "answer") {
    pc.setRemoteDescription({ type: "answer", sdp: signal.sdp }).catch(() => status("Connection handshake error"));
  } else if (signal.type === "ice") {
    pc.addIceCandidate(signal.candidate).catch(() => {});
  }
}

function connectWS(room) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws/" + encodeURIComponent(room) + "?peer=" + encodeURIComponent(myId));
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("signaling connection failed"));
    ws.onmessage = (e) => handleSignal(JSON.parse(e.data));
  });
}

async function startSession() {
  p2pHome.classList.add("hidden");
  setupRTC();
  try {
    await connectWS(roomCode);
    if (isHost) {
      p2pWait.classList.remove("hidden");
      status("Session created — waiting for a peer…");
    } else {
      sendPanel.classList.add("hidden");
      p2pActive.classList.remove("hidden");
      status("Connected — waiting for the sender…");
    }
  } catch (e) {
    toast("Could not connect: " + e.message, "error");
    location.reload();
  }
}

createBtn.addEventListener("click", () => {
  isHost = true;
  roomCode = makeId(6);
  myId = makeId(8);
  const url = location.origin + "/p2p?room=" + roomCode;
  waitLink.value = url;
  startSession();
});

joinBtn.addEventListener("click", () => {
  const room = extractRoom(roomInput.value);
  if (!room) { toast("Enter a valid room link or code", "error"); return; }
  isHost = false;
  myId = makeId(8);
  roomCode = room;
  startSession();
});

roomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinBtn.click(); });

copyWait.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(waitLink.value);
    const span = copyWait.querySelector("span");
    const original = span.textContent;
    span.textContent = "Copied!";
    setTimeout(() => { span.textContent = original; }, 1800);
  } catch (_) {
    waitLink.select();
    document.execCommand("copy");
    toast("Link copied");
  }
});

/* ---------- sending over the data channel ---------- */
function onChannelMessage(ev) {
  if (typeof ev.data === "string") {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === "meta") startReceive(msg.files);
    else if (msg.type === "complete") finishReceive();
    else if (msg.type === "progress") showReceiverProgress(msg.received, msg.total);
  } else {
    receiveChunk(ev.data);
  }
}

function waitForBuffer() {
  return new Promise((resolve) => {
    if (dc.bufferedAmount < BUFFER_LOW) return resolve();
    const iv = setInterval(() => {
      if (dc.bufferedAmount < BUFFER_LOW) { clearInterval(iv); resolve(); }
    }, 50);
  });
}

async function sendFilesNow() {
  if (sending || !sendQueue.length || !dc || dc.readyState !== "open") return;
  sending = true;
  sendBtn.disabled = true;
  sendTotal = sendQueue.reduce((s, f) => s + f.size, 0);
  sentBytes = 0;
  sendProgressWrap.classList.remove("hidden");
  sendBar.style.width = "0%";
  sendText.textContent = "0%";
  sendDetail.textContent = "Sending " + formatSize(sendTotal);

  dc.send(JSON.stringify({ type: "meta", files: sendQueue.map((f, i) => ({ id: i, name: f.name, size: f.size })) }));

  for (let i = 0; i < sendQueue.length; i++) {
    const file = sendQueue[i];
    const size = file.size;
    let offset = 0;
    let chunkIndex = 0;
    while (offset < size) {
      const len = Math.min(CHUNK_SIZE, size - offset);
      const buf = new ArrayBuffer(HEADER_SIZE + len);
      const dv = new DataView(buf);
      dv.setUint32(0, i, true);
      dv.setUint32(4, chunkIndex, true);
      dv.setUint32(8, len, true);
      new Uint8Array(buf, HEADER_SIZE).set(new Uint8Array(await file.slice(offset, offset + len).arrayBuffer()));
      await waitForBuffer();
      dc.send(buf);
      sentBytes += len;
      offset += len;
      chunkIndex++;
      const pct = Math.round((sentBytes / sendTotal) * 100);
      sendBar.style.width = pct + "%";
      sendText.textContent = pct + "%";
      sendDetail.textContent = formatSize(sentBytes) + " of " + formatSize(sendTotal);
    }
  }

  dc.send(JSON.stringify({ type: "complete" }));
  sending = false;
  sendBar.style.width = "100%";
  sendText.textContent = "100%";
  sendDetail.textContent = "Complete";
  toast("Files sent");
}

sendBtn.addEventListener("click", sendFilesNow);

/* ---------- receiving over the data channel ---------- */
function startReceive(files) {
  recvState.files = files;
  recvState.buffers = files.map(() => []);
  recvState.received = 0;
  recvState.total = files.reduce((s, f) => s + f.size, 0);
  recvProgressWrap.classList.remove("hidden");
  recvBar.style.width = "0%";
  recvText.textContent = "0%";
  recvDetail.textContent = "Receiving " + formatSize(recvState.total);
  reportProgress(0, recvState.total);
}

function receiveChunk(buf) {
  const dv = new DataView(buf, 0, HEADER_SIZE);
  const fileId = dv.getUint32(0, true);
  const chunkIndex = dv.getUint32(4, true);
  const payloadLen = dv.getUint32(8, true);
  const payload = new Uint8Array(buf, HEADER_SIZE, payloadLen);
  recvState.buffers[fileId][chunkIndex] = payload;
  recvState.received += payloadLen;
  const pct = recvState.total ? Math.round((recvState.received / recvState.total) * 100) : 0;
  recvBar.style.width = pct + "%";
  recvText.textContent = pct + "%";
  recvDetail.textContent = formatSize(recvState.received) + " of " + formatSize(recvState.total);
  const now = Date.now();
  if (now - recvState.lastProg > 300) {
    recvState.lastProg = now;
    reportProgress(recvState.received, recvState.total);
  }
}

function reportProgress(received, total) {
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "progress", received, total }));
  }
}

function showReceiverProgress(received, total) {
  recvProgressWrap.classList.remove("hidden");
  const pct = total ? Math.round((received / total) * 100) : 0;
  recvBar.style.width = pct + "%";
  recvText.textContent = pct + "%";
  recvDetail.textContent = "Receiver got " + formatSize(received) + " of " + formatSize(total);
}

function finishReceive() {
  recvText.textContent = "Saving…";
  let saved = 0;
  recvState.files.forEach((f, i) => {
    const blob = new Blob(recvState.buffers[i], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    saved++;
  });
  toast("Saved " + saved + " file" + (saved === 1 ? "" : "s"));
  recvDetail.textContent = "Complete — check your downloads";
}

/* ---------- auto-join from a shared link ---------- */
window.addEventListener("DOMContentLoaded", () => {
  const q = new URLSearchParams(location.search).get("room");
  if (q) {
    roomInput.value = q;
    joinBtn.click();
  }
});