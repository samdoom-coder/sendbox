const $ = (id) => document.getElementById(id);

const drop = $("drop");
const fileInput = $("fileInput");
const fileList = $("fileList");
const filePanel = $("filePanel");
const fileCount = $("fileCount");
const fileTotal = $("fileTotal");
const clearBtn = $("clearBtn");
const uploadBtn = $("uploadBtn");
const progressWrap = $("progressWrap");
const progressBar = $("progressBar");
const progressText = $("progressText");
const progressDetail = $("progressDetail");
const uploadState = $("uploadState");
const resultState = $("resultState");
const shareUrl = $("shareUrl");
const copyBtn = $("copyBtn");
const openBtn = $("openBtn");
const newBtn = $("newBtn");
const receiveForm = $("receiveForm");
const keyInput = $("keyInput");
const maxdl = $("maxdl");
const toasts = $("toasts");

let selectedFiles = [];

const icons = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V7m0 0 3.5 3.5M12 7l-3.5 3.5"/><path d="M4 15v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
};
const ICON_SETS = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "bmp"],
  archive: ["zip", "rar", "7z", "tar", "gz"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a"],
  video: ["mp4", "mkv", "mov", "webm", "avi"],
  pdf: ["pdf"],
  code: ["txt", "md", "csv", "json", "xml", "py", "js", "ts", "html", "css", "sh", "c", "cpp"],
};
const EXT_LABEL = { pdf: "PDF" };

function fileIconData(ext) {
  for (const [kind, exts] of Object.entries(ICON_SETS)) {
    if (exts.includes(ext)) return { ext };
  }
  return { ext: "" };
}

function formatSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function toast(message, type = "success") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = (type === "success" ? icons.check : icons.alert) + `<span>${message}</span>`;
  toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 260);
  }, 2600);
}

/* ---------- file picking ---------- */
function addFiles(list) {
  let added = 0;
  for (const f of list) {
    if (!selectedFiles.some((x) => x.name === f.name && x.size === f.size)) {
      selectedFiles.push(f);
      added++;
    }
  }
  if (added) renderFiles();
}

function renderFiles() {
  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  filePanel.classList.toggle("hidden", selectedFiles.length === 0);
  fileCount.textContent = selectedFiles.length + (selectedFiles.length === 1 ? " file" : " files");
  fileTotal.textContent = formatSize(total);
  fileList.innerHTML = "";
  selectedFiles.forEach((f, i) => {
    const li = document.createElement("li");
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const icon = fileIconData(ext);
    const iconEl = document.createElement("span");
    iconEl.className = "file-type";
    iconEl.setAttribute("data-ext", icon.ext);
    iconEl.innerHTML = EXT_LABEL[icon.ext] || icons.file;

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
      selectedFiles.splice(i, 1);
      renderFiles();
    });

    li.append(iconEl, meta, rm);
    fileList.appendChild(li);
  });
  uploadBtn.disabled = selectedFiles.length === 0;
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

clearBtn.addEventListener("click", () => { selectedFiles = []; renderFiles(); });

/* ---------- upload ---------- */
uploadBtn.addEventListener("click", () => {
  if (!selectedFiles.length) return;
  const fd = new FormData();
  selectedFiles.forEach((f) => fd.append("files", f));
  fd.append("expires_hours", document.querySelector('input[name="expiry"]:checked').value);
  fd.append("max_downloads", maxdl.value || "");

  uploadBtn.disabled = true;
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressText.textContent = "0%";
  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  progressDetail.textContent = "Uploading " + formatSize(total);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = pct + "%";
      progressText.textContent = pct + "%";
      progressDetail.textContent = formatSize(e.loaded) + " of " + formatSize(total);
    }
  };
  xhr.onload = () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      showResult(location.origin + "/r/" + data.token);
      selectedFiles = [];
      fileInput.value = "";
      renderFiles();
    } else {
      uploadBtn.disabled = false;
      progressWrap.classList.add("hidden");
      let msg = "Upload failed";
      try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
      toast(msg, "error");
    }
  };
  xhr.onerror = () => {
    uploadBtn.disabled = false;
    progressWrap.classList.add("hidden");
    toast("Upload failed — check your connection", "error");
  };
  xhr.send(fd);
});

function showResult(url) {
  shareUrl.value = url;
  progressWrap.classList.add("hidden");
  uploadState.classList.add("hidden");
  resultState.classList.remove("hidden");
  shareUrl.focus();
  shareUrl.select();
  toast("Files are live");
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    const span = copyBtn.querySelector("span");
    const original = span.textContent;
    copyBtn.querySelector("svg").innerHTML = icons.check.replace(/<svg[^>]*>|<\/svg>/g, "");
    span.textContent = "Copied!";
    setTimeout(() => { span.textContent = original; }, 1800);
  } catch (_) {
    shareUrl.select();
    document.execCommand("copy");
    toast("Link copied", "success");
  }
});

openBtn.addEventListener("click", () => window.open(shareUrl.value, "_blank"));
newBtn.addEventListener("click", () => {
  resultState.classList.add("hidden");
  uploadState.classList.remove("hidden");
  uploadBtn.disabled = true;
});

/* ---------- receive ---------- */
receiveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  let key = keyInput.value.trim();
  if (!key) return;
  const m = key.match(/\/r\/([A-Za-z0-9_-]+)/);
  const token = m ? m[1] : key.split("/").pop();
  location.href = "/r/" + encodeURIComponent(token);
});

/* keyboard shortcut: open browser picker */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o" && !resultState.classList.contains("hidden")) {
    e.preventDefault();
    newBtn.click();
  }
});
