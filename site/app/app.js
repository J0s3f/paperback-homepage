// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Josef H.B. Schneider

// The WebAssembly module is not part of the page: the first interaction with the decoder or
// the encoder loads it (2.5 MB). Until then this is a plain static page. The module runs in
// a Web Worker (app/worker.js), so this script stays responsive: it can show progress while
// the worker decodes or encodes, and it can block the page until the work is done.

console.info("paperback-web app loaded (the decoder loads on first use)");

const NO_PAGES = "No pages loaded yet. Drop images or a PDF, or use the sample buttons.";

// --- state -------------------------------------------------------------------

let worker = null;
let initPromise = null;
let pending = null;
let progressHandler = null;

const loadedPages = [];
let nextSourceId = 1;

// --- elements ----------------------------------------------------------------

const statusEl = document.getElementById("decoder-status");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileList = document.getElementById("file-list");
const passwordEl = document.getElementById("password");
const decodeButton = document.getElementById("decode-button");
const clearButton = document.getElementById("clear-button");
const errorEl = document.getElementById("decoder-error");
const resultEl = document.getElementById("decoder-result");
const sampleButtons = document.querySelectorAll(".sample-button[data-sample]");

const encodeStatusEl = document.getElementById("encode-status");
const encodeDropZone = document.getElementById("encode-drop-zone");
const encodeFileInput = document.getElementById("encode-file-input");
const encodeFileList = document.getElementById("encode-file-list");
const encodePresetEl = document.getElementById("encode-preset");
const encodeRedundancyField = document.getElementById("encode-redundancy-field");
const encodeRedundancyEl = document.getElementById("encode-redundancy");
const encodeRedundancyValueEl = document.getElementById("encode-redundancy-value");
const encodeParityField = document.getElementById("encode-parity-field");
const encodeParityEl = document.getElementById("encode-parity");
const encodeParityValueEl = document.getElementById("encode-parity-value");
const encodePrinterEl = document.getElementById("encode-printer");
const encodePrinterDpiEl = document.getElementById("encode-printer-dpi");
const encodeDotDpiEl = document.getElementById("encode-dot-dpi");
const encodeDotPercentEl = document.getElementById("encode-dot-percent");
const encodePaperEl = document.getElementById("encode-paper");
const encodeCompressionEl = document.getElementById("encode-compression");
const encodePasswordEl = document.getElementById("encode-password");
const encodeButton = document.getElementById("encode-button");
const encodeClearButton = document.getElementById("encode-clear-button");
const encodeErrorEl = document.getElementById("encode-error");
const encodeResultEl = document.getElementById("encode-result");

const busyEl = document.getElementById("busy");
const busyTextEl = document.getElementById("busy-text");
const busyBarEl = document.getElementById("busy-bar");
const busyFillEl = document.getElementById("busy-fill");
const mainEl = document.querySelector("main");

// --- worker plumbing ---------------------------------------------------------

function onWorkerMessage(event) {
  const message = event.data;
  if (message.type === "progress") {
    if (progressHandler) progressHandler(message);
    return;
  }
  const current = pending;
  pending = null;
  if (!current) return;
  if (message.type === "error") {
    current.reject(new Error(message.message));
  } else {
    current.resolve(message);
  }
}

/** Sends one message to the worker and resolves with its answer. */
function call(message, transfer = []) {
  if (!worker) return Promise.reject(new Error("the decoder is not loaded"));
  if (pending) return Promise.reject(new Error("the decoder is already busy"));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage(message, transfer);
  });
}

function initFailureMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Lets the browser paint the busy overlay before the worker starts. Not
 * requestAnimationFrame: that never fires in a hidden tab, which would hang the page.
 */
function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Starts the worker on first use: it loads the WebAssembly module, so nothing is fetched
 * before this is called.
 */
function ensureInit() {
  if (worker) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      setStatus("Loading decoder (2.5 MB, stays in your browser)…");
      const created = new Worker("app/worker.js", { type: "module" });
      created.onmessage = onWorkerMessage;
      created.onerror = event => {
        const message = event.message || "the decoder worker failed";
        if (pending) {
          const current = pending;
          pending = null;
          current.reject(new Error(message));
        } else {
          setError(`Decoder error: ${message}`);
        }
      };
      worker = created;
      const ready = await call({ type: "init" });
      setStatus(`Decoder ready (paperback-rs ${ready.version})`);
      clearError();
    })().catch(error => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/** Loads the module and reports a failure in the given place; false when it did not load. */
async function ensureInitOrReport(report) {
  try {
    await ensureInit();
    return true;
  } catch (e) {
    report(`Initialization error: ${initFailureMessage(e)}`);
    return false;
  }
}

// --- busy overlay ------------------------------------------------------------

let busyTimer = null;

/** Blocks the page and shows what is being worked on. */
function startBusy(text, determinate) {
  busyTextEl.textContent = text;
  busyBarEl.hidden = !determinate;
  if (determinate) busyFillEl.style.width = "0%";
  busyEl.hidden = false;
  mainEl.inert = true;
  document.body.classList.add("busy");
  document.body.setAttribute("aria-busy", "true");
  if (!determinate) {
    // No per-step progress to report; show that time is passing instead.
    const started = performance.now();
    busyTimer = setInterval(() => {
      busyTextEl.textContent = `${text} — ${((performance.now() - started) / 1000).toFixed(0)} s`;
    }, 500);
  }
}

function updateBusy(done, total) {
  busyFillEl.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
}

function stopBusy() {
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
  busyEl.hidden = true;
  mainEl.inert = false;
  document.body.classList.remove("busy");
  document.body.removeAttribute("aria-busy");
}

// --- small helpers -----------------------------------------------------------

function setStatus(text) {
  statusEl.textContent = text;
}

function setError(text) {
  errorEl.textContent = text;
}

function clearError() {
  errorEl.textContent = "";
}

function pageCount() {
  return loadedPages.length;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Common types, so the saved file opens with the right program. */
const MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  heic: "image/heic"
};

function mimeOf(name) {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && MIME_TYPES[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/**
 * The name a restored file is saved under. It never goes without an extension: macOS
 * Safari saves extensionless downloads as ".dms" (a known bug of its own), so a name
 * without one gets ".bin" instead.
 */
function downloadFileName(name) {
  const base = (name || "").split(/[\\/]/).pop() || "restored-file";
  return /\.[A-Za-z0-9]{1,10}$/.test(base) ? base : `${base}.bin`;
}

function addFileChip(name, text, sourceId) {
  const chip = document.createElement("div");
  chip.className = "file-chip";
  const label = document.createElement("span");
  label.textContent = `${name} — ${text}`;
  chip.appendChild(label);
  if (sourceId !== undefined) {
    chip.dataset.sourceId = String(sourceId);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.title = "Remove this file";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      removeSource(sourceId);
    });
    chip.appendChild(remove);
  }
  fileList.appendChild(chip);
}

function updateButtons() {
  const hasPages = pageCount() > 0;
  decodeButton.disabled = !hasPages;
  clearButton.disabled = !hasPages;
}

function showResult() {
  resultEl.hidden = false;
}

function hideResult() {
  resultEl.hidden = true;
  resultEl.innerHTML = "";
}

// --- decoding ----------------------------------------------------------------

function downscaleCanvas(canvas, maxSide = 16384, maxPixels = 16_000_000) {
  const { width, height } = canvas;
  let scale = 1;
  if (width > maxSide || height > maxSide) {
    scale = Math.min(scale, maxSide / Math.max(width, height));
  }
  const pixels = width * height;
  if (pixels > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / pixels));
  }
  if (scale >= 1) return canvas;

  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const newCanvas = document.createElement("canvas");
  newCanvas.width = newWidth;
  newCanvas.height = newHeight;
  const ctx = newCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, newWidth, newHeight);
  return newCanvas;
}

function grayscaleFromImageData(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    gray[j++] = Math.floor((r + g + b) / 3);
  }
  return gray;
}

async function loadFile(file) {
  if (!(await ensureInitOrReport(setError))) {
    setStatus("Decoder failed to load");
    return;
  }
  const name = file.name;
  const sourceId = nextSourceId++;
  setStatus(`Loading ${name}…`);
  clearError();

  const startIndex = pageCount();
  let previewCanvas = null;
  let hasPreview = false;
  let addedPages = null;

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();

    const downscaled = downscaleCanvas(canvas);
    const imageData = downscaled
      .getContext("2d")
      .getImageData(0, 0, downscaled.width, downscaled.height);
    const gray = grayscaleFromImageData(imageData);
    await call(
      { type: "addPage", width: downscaled.width, height: downscaled.height, gray },
      [gray.buffer]
    );
    previewCanvas = downscaled;
    hasPreview = true;
  } catch (e) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const reply = await call({ type: "addImage", bytes }, [bytes.buffer]);
      addedPages = reply.pages;
      if (!addedPages || addedPages.length === 0) {
        throw new Error("No pages could be read from file");
      }
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      addFileChip(name, `error: ${msg}`, sourceId);
      setStatus(pageCount() > 0 ? `${pageCount()} page(s) ready` : NO_PAGES);
      updateButtons();
      return;
    }
  }

  if (hasPreview) {
    loadedPages.push({ sourceId, sourceName: name, previewCanvas, grayPreview: null });
  } else {
    for (const page of addedPages) {
      loadedPages.push({ sourceId, sourceName: name, previewCanvas: null, grayPreview: page });
    }
  }

  const count = pageCount() - startIndex;
  addFileChip(name, `${count} page(s)`, sourceId);
  setStatus(`${pageCount()} page(s) ready`);
  updateButtons();
}

async function loadFiles(files) {
  for (const file of files) {
    await loadFile(file);
  }
}

/** Removes one chosen file and its pages from the decoder. */
async function removeSource(sourceId) {
  if (!worker) return;
  const pages = loadedPages.filter(page => page.sourceId === sourceId);
  // Highest index first, so the pages that stay keep their numbers while removing.
  for (const page of [...pages].sort((a, b) => b.pageIndex - a.pageIndex)) {
    try {
      await call({ type: "removePage", index: page.pageIndex });
    } catch (e) {
      /* the page is gone from the list below either way */
    }
  }
  for (let at = loadedPages.length - 1; at >= 0; at--) {
    if (loadedPages[at].sourceId === sourceId) loadedPages.splice(at, 1);
  }
  for (const chip of [...fileList.querySelectorAll(".file-chip")]) {
    if (chip.dataset.sourceId === String(sourceId)) chip.remove();
  }
  hideResult();
  clearError();
  setStatus(pageCount() > 0 ? `${pageCount()} page(s) ready` : NO_PAGES);
  updateButtons();
}

async function handleSampleClick(button) {
  if (!(await ensureInitOrReport(setError))) {
    setStatus("Decoder failed to load");
    return;
  }
  const url = button.dataset.sample;
  if (!url) return;
  setStatus(`Fetching sample ${url}…`);
  clearError();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const name = url.split("/").pop() || "sample";
    const file = new File([blob], name, { type: blob.type });
    await loadFile(file);
    if (pageCount() > 0) {
      await doDecode();
    }
  } catch (e) {
    setError(`Sample load failed: ${initFailureMessage(e)}`);
    setStatus(pageCount() > 0 ? `${pageCount()} page(s) ready` : NO_PAGES);
  }
}

function rgbaFromRgb(rgb, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return rgba;
}

function grayToRgba(gray, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = gray[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  return rgba;
}

function createPageCard(pageResult, index, overlays) {
  const card = document.createElement("div");
  card.className = "page-card";

  const head = document.createElement("div");
  head.className = "page-head";

  const title = document.createElement("h3");
  title.className = "page-title";
  const pageInfo = loadedPages[index];
  const sourceName = pageInfo ? pageInfo.sourceName : `page ${index + 1}`;
  title.textContent = `Page ${index + 1} — ${sourceName}`;
  head.appendChild(title);

  const badge = document.createElement("span");
  badge.className = `badge ${pageResult.ok ? "ok" : "bad"}`;
  badge.textContent = pageResult.ok ? "readable" : "unreadable";
  head.appendChild(badge);

  card.appendChild(head);

  const viewButtons = document.createElement("div");
  viewButtons.className = "view-buttons";

  const overlayBtn = document.createElement("button");
  overlayBtn.className = "view-button active";
  overlayBtn.dataset.view = "overlay";
  overlayBtn.textContent = "Overlay";
  overlayBtn.disabled = pageResult.overlayWidth === 0 || pageResult.overlayHeight === 0;

  const originalBtn = document.createElement("button");
  originalBtn.className = "view-button";
  originalBtn.dataset.view = "original";
  originalBtn.textContent = "Original";

  viewButtons.appendChild(overlayBtn);
  viewButtons.appendChild(originalBtn);
  card.appendChild(viewButtons);

  const pageViews = document.createElement("div");
  pageViews.className = "page-views";

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.className = "page-canvas view-overlay active";
  const originalCanvas = document.createElement("canvas");
  originalCanvas.className = "page-canvas view-original";

  pageViews.appendChild(overlayCanvas);
  pageViews.appendChild(originalCanvas);
  card.appendChild(pageViews);

  const stats = document.createElement("div");
  stats.className = "page-stats";
  stats.textContent = `good ${pageResult.goodBlocks} · corrected ${pageResult.restoredBytes} B · bad ${pageResult.badBlocks} · misplaced ${pageResult.misplacedBlocks}`;
  card.appendChild(stats);

  if (!pageResult.ok) {
    const errorDiv = document.createElement("div");
    errorDiv.className = "page-error";
    errorDiv.textContent = pageResult.error || "Unknown error";
    card.appendChild(errorDiv);
  }

  function switchView(view) {
    const isOverlay = view === "overlay";
    overlayCanvas.classList.toggle("active", isOverlay);
    originalCanvas.classList.toggle("active", !isOverlay);
    overlayBtn.classList.toggle("active", isOverlay);
    originalBtn.classList.toggle("active", !isOverlay);
  }

  overlayBtn.addEventListener("click", () => switchView("overlay"));
  originalBtn.addEventListener("click", () => switchView("original"));

  const overlay = overlays && overlays[index];
  if (pageResult.overlayWidth > 0 && pageResult.overlayHeight > 0 && overlay && overlay.length > 0) {
    const rgba = rgbaFromRgb(overlay, pageResult.overlayWidth, pageResult.overlayHeight);
    const imageData = new ImageData(rgba, pageResult.overlayWidth, pageResult.overlayHeight);
    overlayCanvas.width = pageResult.overlayWidth;
    overlayCanvas.height = pageResult.overlayHeight;
    overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);
  } else {
    overlayCanvas.width = 1;
    overlayCanvas.height = 1;
    overlayBtn.disabled = true;
    overlayBtn.textContent = "Overlay (N/A)";
  }

  if (pageInfo && pageInfo.previewCanvas) {
    originalCanvas.width = pageInfo.previewCanvas.width;
    originalCanvas.height = pageInfo.previewCanvas.height;
    originalCanvas.getContext("2d").drawImage(pageInfo.previewCanvas, 0, 0);
  } else if (pageInfo && pageInfo.grayPreview) {
    const { width, height, gray } = pageInfo.grayPreview;
    originalCanvas.width = width;
    originalCanvas.height = height;
    originalCanvas
      .getContext("2d")
      .putImageData(new ImageData(grayToRgba(gray, width, height), width, height), 0, 0);
  }

  return card;
}

async function doDecode() {
  if (!(await ensureInitOrReport(setError))) {
    setStatus("Decoder failed to load");
    return;
  }
  const password = passwordEl.value || null;
  decodeButton.disabled = true;
  clearButton.disabled = true;
  clearError();
  startBusy(`Decoding ${pageCount()} page(s)…`, pageCount() > 1);
  progressHandler = message => {
    if (message.phase === "decode") updateBusy(message.done, message.total);
  };

  try {
    await yieldToBrowser();

    const reply = await call({ type: "decode", password });
    progressHandler = null;
    const result = reply.result;

    hideResult();
    resultEl.innerHTML = "";

    if (!result.compatible) {
      const banner = document.createElement("div");
      banner.className = "error-banner";
      banner.textContent = result.error || "Decoding failed: incompatible pages";
      resultEl.appendChild(banner);
      showResult();
      return;
    }

    const summary = document.createElement("div");
    summary.className = "summary";

    const summaryFile = document.createElement("div");
    summaryFile.className = "summary-file";
    summaryFile.textContent = `${result.fileName || "restored file"} — ${humanSize(result.fileSize)}`;
    summary.appendChild(summaryFile);

    const downloadLink = document.createElement("a");
    downloadLink.className = "download";
    const fileName = downloadFileName(result.fileName);
    downloadLink.href = URL.createObjectURL(new Blob([reply.file], { type: mimeOf(fileName) }));
    downloadLink.download = fileName;
    downloadLink.textContent = "Download restored file";
    summary.appendChild(downloadLink);

    const summaryStats = document.createElement("div");
    summaryStats.className = "summary-stats";
    let statsText = `${result.pageCount} page(s)`;
    if (result.recoveredBlocks > 0) {
      statsText += ` · recovered ${result.recoveredBlocks} block(s) from recovery data`;
    }
    if (result.misplacedBlocks > 0) {
      statsText += ` · ${result.misplacedBlocks} misplaced block(s)`;
    }
    summaryStats.textContent = statsText;
    summary.appendChild(summaryStats);

    resultEl.appendChild(summary);

    const pagesContainer = document.createElement("div");
    pagesContainer.className = "pages";
    for (const pageResult of result.pages) {
      pagesContainer.appendChild(createPageCard(pageResult, pageResult.index, reply.overlays));
    }
    resultEl.appendChild(pagesContainer);
    showResult();
  } catch (e) {
    progressHandler = null;
    setError(`Decode error: ${initFailureMessage(e)}`);
    hideResult();
  } finally {
    progressHandler = null;
    stopBusy();
    updateButtons();
    setStatus(pageCount() > 0 ? `${pageCount()} page(s) ready` : NO_PAGES);
  }
}

// --- encoding ----------------------------------------------------------------

const encodeState = { file: null };
let encodeUrls = [];

/** Printer presets: resolution of the printer, dot density on paper, and dot size. */
const PRINTER_PRESETS = {
  // 2 pixels per dot at 300 dpi: scan at about 600 dpi (the library's own "d-robust" case
  // shows that 2 pixels per dot do not survive a scan). If prints come out faint at 80 %
  // dots (1 px = 0.085 mm), raise the dot size to 100 % or the printer resolution to 600.
  inkjet: { printerDpi: 300, dotDpi: 150, dotPercent: 80 },
  laser: { printerDpi: 600, dotDpi: 300, dotPercent: 70 },
  // 2 pixels per dot at 150 dpi: a coarse, very visible grid (0.34 mm pitch) that even a
  // 12 MP phone resolves when the sheet fills the frame; about a quarter of the capacity of
  // a 150 dpi page.
  camera: { printerDpi: 150, dotDpi: 75, dotPercent: 80 }
};

const PRINTER_LABELS = {
  inkjet: "Inkjet",
  laser: "Laser",
  camera: "Camera-readable",
  custom: "Custom"
};

function applyPrinterPreset() {
  const preset = PRINTER_PRESETS[encodePrinterEl.value];
  if (!preset) return;
  encodePrinterDpiEl.value = preset.printerDpi;
  encodeDotDpiEl.value = preset.dotDpi;
  encodeDotPercentEl.value = preset.dotPercent;
}

encodePrinterEl.addEventListener("change", applyPrinterPreset);
for (const field of [encodePrinterDpiEl, encodeDotDpiEl, encodeDotPercentEl]) {
  field.addEventListener("input", () => {
    encodePrinterEl.value = "custom";
  });
}

/** Error-correction presets: recovery-block group size (0 = off) and parity per 100 blocks. */
const ERROR_CORRECTION_PRESETS = {
  modern: { redundancy: 0, parity: 20 },
  balanced: { redundancy: 10, parity: 10 },
  legacy: { redundancy: 5, parity: 0 }
};

/**
 * The redundancy slider shows strength, not the raw group size: to the right is more
 * protection. Level 0 is off, level 1 is one recovery block per 10 data blocks (the
 * weakest), level 9 is one per 2 (the strongest).
 */
function redundancyLevelToGroup(level) {
  return level === 0 ? 0 : 11 - level;
}

function redundancyGroupToLevel(group) {
  return group === 0 ? 0 : 11 - group;
}

function updateRedundancyLabel() {
  const group = redundancyLevelToGroup(Number(encodeRedundancyEl.value));
  encodeRedundancyValueEl.textContent =
    group === 0
      ? "off"
      : `one recovery block per ${group} data blocks (${Math.round(100 / group)} %)`;
}

function updateParityLabel() {
  encodeParityValueEl.textContent = `${Number(encodeParityEl.value)} %`;
}

/** Fills the sliders from the chosen preset and hides the one the preset does not use. */
function applyErrorCorrectionPreset() {
  const preset = ERROR_CORRECTION_PRESETS[encodePresetEl.value];
  if (!preset) return;
  encodeRedundancyEl.value = String(redundancyGroupToLevel(preset.redundancy));
  encodeParityEl.value = String(preset.parity);
  encodeRedundancyField.hidden = preset.redundancy === 0;
  encodeParityField.hidden = preset.parity === 0;
  updateRedundancyLabel();
  updateParityLabel();
}

encodePresetEl.addEventListener("change", applyErrorCorrectionPreset);
encodeRedundancyEl.addEventListener("input", updateRedundancyLabel);
encodeParityEl.addEventListener("input", updateParityLabel);

function readEncodeSettings() {
  const printerDpi = Number(encodePrinterDpiEl.value);
  const dotDpi = Number(encodeDotDpiEl.value);
  const dotPercent = Number(encodeDotPercentEl.value);
  if (!Number.isInteger(printerDpi) || printerDpi < 150 || printerDpi > 2400) {
    throw new Error("the printer resolution must be between 150 and 2400 dpi");
  }
  if (!Number.isInteger(dotDpi) || dotDpi < 50 || dotDpi > 600) {
    throw new Error("the dot density must be between 50 and 600 dpi");
  }
  if (!Number.isInteger(dotPercent) || dotPercent < 20 || dotPercent > 100) {
    throw new Error("the dot size must be between 20 and 100 percent");
  }
  if (dotDpi * 2 > printerDpi) {
    throw new Error("the dot density must be at most half the printer resolution");
  }
  const redundancy = redundancyLevelToGroup(Number(encodeRedundancyEl.value));
  const parityPercent = Number(encodeParityEl.value);
  if (!(redundancy === 0 || (redundancy >= 2 && redundancy <= 10))) {
    throw new Error("the redundancy must be off or between 2 and 10");
  }
  if (!Number.isInteger(parityPercent) || parityPercent < 0 || parityPercent > 100) {
    throw new Error("the parity must be between 0 and 100 percent");
  }
  return {
    preset: encodePresetEl.value,
    printer: encodePrinterEl.value,
    paper: encodePaperEl.value,
    compression: encodeCompressionEl.value,
    password: encodePasswordEl.value || null,
    printerDpi,
    dotDpi,
    dotPercent,
    redundancy,
    parityPercent
  };
}

function setEncodeStatus(text) {
  encodeStatusEl.textContent = text;
}

function setEncodeError(text) {
  encodeErrorEl.textContent = text;
}

function updateEncodeButtons() {
  encodeButton.disabled = !encodeState.file;
  encodeClearButton.disabled = !encodeState.file && encodeResultEl.hidden;
}

/** The file name without its extension, for naming the downloads. */
function stemOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function padded(index) {
  return String(index + 1).padStart(3, "0");
}

function chooseEncodeFile(file) {
  encodeState.file = file;
  encodeFileList.innerHTML = "";
  const chip = document.createElement("div");
  chip.className = "file-chip";
  const label = document.createElement("span");
  label.textContent = `${file.name} — ${humanSize(file.size)}`;
  chip.appendChild(label);
  encodeFileList.appendChild(chip);
  setEncodeStatus("Ready to encode.");
  setEncodeError("");
  updateEncodeButtons();
}

function revokeEncodeUrls() {
  for (const url of encodeUrls) URL.revokeObjectURL(url);
  encodeUrls = [];
}

function clearEncode() {
  revokeEncodeUrls();
  encodeState.file = null;
  encodeFileList.innerHTML = "";
  encodeResultEl.hidden = true;
  encodeResultEl.innerHTML = "";
  setEncodeStatus("Pick a file to encode — it never leaves your browser.");
  setEncodeError("");
  updateEncodeButtons();
}

const MAX_ENCODE_BYTES = 150 * 1024 * 1024;

async function runEncode() {
  if (!encodeState.file) return;
  if (!(await ensureInitOrReport(setEncodeError))) {
    setEncodeStatus("Decoder failed to load");
    return;
  }
  const file = encodeState.file;
  let settings;
  try {
    settings = readEncodeSettings();
  } catch (e) {
    setEncodeError(`Settings: ${initFailureMessage(e)}`);
    return;
  }
  encodeButton.disabled = true;
  encodeClearButton.disabled = true;
  setEncodeError("");
  setEncodeStatus(`Reading ${file.name}…`);
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length > MAX_ENCODE_BYTES) {
      throw new Error(`the file is larger than ${humanSize(MAX_ENCODE_BYTES)}`);
    }
    const printerLabel = PRINTER_LABELS[settings.printer] || settings.printer;
    startBusy(
      `Encoding ${file.name} (${humanSize(data.length)}) with the ${printerLabel} preset…`,
      false
    );
    await yieldToBrowser();
    const started = performance.now();
    const reply = await call(
      { type: "encode", data, name: file.name, settings },
      [data.buffer]
    );
    const result = reply.result;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    revokeEncodeUrls();
    encodeResultEl.innerHTML = "";
    const stem = stemOf(file.name);

    const summary = document.createElement("div");
    summary.className = "summary";
    const summaryFile = document.createElement("div");
    summaryFile.className = "summary-file";
    summaryFile.textContent = `${result.fileName} — ${humanSize(result.sourceSize)}`;
    summary.appendChild(summaryFile);

    const pdfUrl = URL.createObjectURL(new Blob([result.pdf], { type: "application/pdf" }));
    encodeUrls.push(pdfUrl);
    const pdfLink = document.createElement("a");
    pdfLink.className = "download";
    pdfLink.href = pdfUrl;
    pdfLink.download = `${stem}-paperback.pdf`;
    pdfLink.textContent = `Download PDF (${result.pageCount} page${result.pageCount === 1 ? "" : "s"})`;
    summary.appendChild(pdfLink);

    const summaryStats = document.createElement("div");
    summaryStats.className = "summary-stats";
    let errorCorrection = "";
    if (settings.redundancy > 0) {
      errorCorrection += ` · redundancy one per ${settings.redundancy}`;
    }
    if (settings.parityPercent > 0) {
      errorCorrection += ` · parity ${settings.parityPercent} %`;
    }
    summaryStats.textContent =
      `${result.pageCount} page(s) · ${result.dpi}/${settings.dotDpi} dpi · dots ${settings.dotPercent} %` +
      `${errorCorrection} · ${printerLabel} preset · encoded in ${seconds} s`;
    summary.appendChild(summaryStats);
    encodeResultEl.appendChild(summary);

    const pages = document.createElement("div");
    pages.className = "encode-pages";
    for (const page of result.pages) {
      const item = document.createElement("div");
      item.className = "encode-page";
      const url = URL.createObjectURL(new Blob([page.png], { type: "image/png" }));
      encodeUrls.push(url);
      const img = document.createElement("img");
      img.className = "page-image";
      img.src = url;
      img.alt = `Page ${page.index + 1}`;
      img.loading = "lazy";
      item.appendChild(img);
      const link = document.createElement("a");
      link.className = "download small";
      link.href = url;
      link.download = `${stem}-page-${padded(page.index)}.png`;
      link.textContent = `Page ${page.index + 1} (PNG)`;
      item.appendChild(link);
      pages.appendChild(item);
    }
    encodeResultEl.appendChild(pages);
    encodeResultEl.hidden = false;
    setEncodeStatus(`Encoded ${result.pageCount} page(s).`);
  } catch (e) {
    setEncodeError(`Encoding failed: ${initFailureMessage(e)}`);
    setEncodeStatus("Encoding failed.");
  } finally {
    stopBusy();
    updateEncodeButtons();
  }
}

// --- wiring ------------------------------------------------------------------

async function clearAll() {
  if (!worker) return;
  try {
    await call({ type: "clear" });
  } catch (e) {
    /* the local state is reset below either way */
  }
  loadedPages.length = 0;
  fileList.innerHTML = "";
  hideResult();
  setStatus(NO_PAGES);
  clearError();
  updateButtons();
}

decodeButton.addEventListener("click", doDecode);

clearButton.addEventListener("click", () => {
  clearAll();
});

fileInput.addEventListener("change", async () => {
  if (fileInput.files.length > 0) {
    await loadFiles(fileInput.files);
    fileInput.value = "";
  }
});

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", async e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    await loadFiles(e.dataTransfer.files);
  }
});

for (const button of sampleButtons) {
  button.addEventListener("click", () => {
    handleSampleClick(button);
  });
}

encodeFileInput.addEventListener("change", () => {
  if (encodeFileInput.files.length > 0) {
    chooseEncodeFile(encodeFileInput.files[0]);
    encodeFileInput.value = "";
  }
});

encodeDropZone.addEventListener("dragover", e => {
  e.preventDefault();
  encodeDropZone.classList.add("drag-over");
});

encodeDropZone.addEventListener("dragleave", () => {
  encodeDropZone.classList.remove("drag-over");
});

encodeDropZone.addEventListener("drop", e => {
  e.preventDefault();
  encodeDropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    chooseEncodeFile(e.dataTransfer.files[0]);
  }
});

encodeButton.addEventListener("click", runEncode);
encodeClearButton.addEventListener("click", clearEncode);

applyPrinterPreset();
applyErrorCorrectionPreset();
setStatus("Decoder loads on first use (2.5 MB, stays in your browser).");
setEncodeStatus("Pick a file to encode — it never leaves your browser.");
updateButtons();
updateEncodeButtons();

window.__paperbackApp = {
  ensureInit,
  addFiles: loadFiles,
  decode: doDecode,
  encode: runEncode,
  pageCount
};
