import { LIMITS, formatBytes, checkAbort, sniffType, imagePreview, imagePixels, decodeImage, validateCover, processImage, safeFilename, uniqueFilename } from "./image-utils.js?v=2026.11.15.1";
import { LocalAI } from "./ai-client.js?v=2026.11.15.1";
import { LocalWorker } from "./worker-client.js?v=2026.11.15.1";
import { readMetadata, gpsSummary, metadataText } from "./metadata.js?v=2026.11.15.1";

const APP_VERSION = "2026.11.15.1";
const $ = id => document.getElementById(id);
const state = { items: [], activeId: null, busy: false, controller: null, selectedCover: null, drawing: false, resultView: false, previewLoading: false, resultPreviewId: null };
const ai = new LocalAI();
const metadataWriter = new LocalWorker(new URL("./metadata-worker.js?v=2026.11.15.1", import.meta.url), "metadata");
const urls = new Set();
const downloadTimers = new Set();
let sequence = 0, coverSequence = 0, previewToken = 0, metadataToken = 0;
let gesture;
let logoFile;
const active = () => state.items.find(item => item.id === state.activeId);
const viewed = () => state.items.find(item => item.id === state.resultPreviewId);
const selectedItems = () => state.items.filter(item => item.selected);
const readyItems = () => state.items.filter(item => item.output);
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

function status(text) { $("status").textContent = text; }
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function showError(error) { $("error").textContent = error.message || String(error); $("error").hidden = false; }
function objectUrl(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
function releaseUrl(url) { if (url) { URL.revokeObjectURL(url); urls.delete(url); } }

function download(blob, name) {
  const url = objectUrl(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  const timer = setTimeout(() => { releaseUrl(url); downloadTimers.delete(timer); }, 30000);
  downloadTimers.add(timer);
}

function clearMetadata() {
  metadataToken++;
  $("metadata").textContent = "";
  $("metadata-summary").textContent = "Metadata is read locally. Choose Read original or Inspect result.";
}

function updateControls() {
  const item = active(), ready = readyItems(), count = selectedItems().length;
  for (const element of document.querySelectorAll("[data-lock]")) element.disabled = state.busy;
  $("resize-fields").disabled = state.busy || !$("resize").checked;
  $("target-fields").disabled = state.busy || !$("target").checked;
  $("watermark-fields").disabled = state.busy || $("watermark-kind").value === "none";
  $("resize-fields").hidden = !$("resize").checked;
  $("target-fields").hidden = !$("target").checked;
  $("watermark-fields").hidden = $("watermark-kind").value === "none";
  $("keep-metadata-note").hidden = $("remove-metadata").checked;
  $("watermark-text-field").hidden = $("watermark-kind").value === "logo";
  $("watermark-logo-field").hidden = $("watermark-kind").value !== "logo";
  $("quality-value").textContent = `${$("quality").value}%`;
  $("opacity-value").textContent = `${$("watermark-opacity").value}%`;
  $("process").disabled = state.busy || !count || !!gesture;
  $("download-zip").disabled = state.busy || !ready.length;
  $("download-preview").disabled = state.busy || !viewed()?.output;
  $("result-zoom").disabled = state.busy || !viewed()?.output || $("result-full-image").hidden;
  $("remove-selected").disabled = state.busy || !count;
  for (const id of ["select-all", "select-none", "clear"]) $(id).disabled = state.busy || !state.items.length;
  for (const id of ["download-one", "view-result", "read-result-metadata"]) $(id).disabled = state.busy || !item?.output;
  for (const id of ["view-original", "detect-faces", "draw-cover", "add-cover", "read-original-metadata"]) $(id).disabled = state.busy || !item || state.previewLoading;
  $("clear-covers").disabled = state.busy || !item?.covers.length;
  $("undo-cover").disabled = state.busy || !item?.coverHistory.length;
  $("apply-cover").disabled = $("delete-cover").disabled = state.busy || !state.selectedCover;
  $("draw-cover").setAttribute("aria-pressed", String(state.drawing));
  $("view-original").setAttribute("aria-pressed", String(!state.resultView));
  $("view-result").setAttribute("aria-pressed", String(state.resultView));
  $("cancel").hidden = !state.busy;
  $("cancel").disabled = !!state.controller?.signal.aborted;
  $("selection-count").textContent = `${count} selected`;
  $("image-count").textContent = `${state.items.length} IMAGE${state.items.length === 1 ? "" : "S"}`;
  $("result-count").textContent = `${ready.length} of ${state.items.length} results ready`;
  $("results").hidden = !ready.length;
  $("output-count").textContent = `${ready.length} OF ${state.items.length} READY`;
  $("result-hint").textContent = ready.length ? `${formatBytes(ready.reduce((sum, file) => sum + file.output.blob.size, 0))} total. ZIP includes prepared results only.` :
    state.items.length ? "Select images and process them. Originals are kept." : "Choose images to get started.";
  for (const entry of state.items) {
    if (!entry.element) continue;
    entry.element.querySelector('[data-action="download"]').disabled = state.busy || !entry.output;
    entry.element.querySelector("[data-select]").disabled = state.busy;
  }
}

async function task(message, action) {
  if (state.busy) return;
  clearError();
  cancelGesture();
  state.busy = true;
  state.controller = new AbortController();
  status(message); updateControls();
  try { await action(state.controller.signal); }
  catch (error) {
    if (error.name === "AbortError") status("Cancelled. Completed results are kept; originals have not changed.");
    else { showError(error); status("That operation could not finish. Your original images have not changed."); }
  } finally {
    state.busy = false; state.controller = null;
    $("progress").hidden = true;
    renderCards(); updateControls();
  }
}

function action(callback) {
  if (state.busy) return;
  clearError();
  try { callback(); }
  catch (error) { showError(error); }
}

function cardButton(text, name) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "text-button"; button.textContent = text;
  button.dataset.action = name; button.setAttribute("data-lock", "");
  return button;
}

function thumbnailButton(url, label, action) {
  const button = cardButton("", action);
  button.className = "thumb-button"; button.setAttribute("aria-label", label);
  const image = document.createElement("img"); image.alt = ""; image.loading = "lazy";
  image.src = url;
  button.append(image);
  return button;
}

function createCard(item) {
  const card = document.createElement("li");
  card.className = "image-card"; card.dataset.id = item.id;
  const label = document.createElement("label"); label.className = "card-top";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox"; checkbox.setAttribute("data-select", ""); checkbox.setAttribute("data-lock", "");
  checkbox.setAttribute("aria-label", `Select ${item.file.name}`);
  const name = document.createElement("span"); name.className = "card-name";
  name.textContent = item.file.name; name.title = item.file.name;
  label.append(checkbox, name);
  const preview = thumbnailButton(item.thumbnail, `Inspect ${item.file.name}`, "inspect");
  const info = document.createElement("p"); info.className = "card-info";
  info.textContent = `${item.width} x ${item.height} / ${formatBytes(item.file.size)}`;
  const summary = document.createElement("p"); summary.className = "card-state";
  const buttons = document.createElement("div"); buttons.className = "card-actions";
  buttons.append(cardButton("Inspect", "inspect"), cardButton("Download", "download"), cardButton("Remove", "remove"));
  card.append(label, preview, info, summary, buttons);
  item.element = card;
  return card;
}

function createResultCard(item) {
  const output = item.output, card = document.createElement("li");
  card.className = "result-card"; card.dataset.id = item.id;
  const heading = document.createElement("div"); heading.className = "card-top";
  const name = document.createElement("span"); name.className = "card-name";
  name.textContent = output.name; name.title = output.name;
  heading.append(name);
  const preview = thumbnailButton(output.thumbnail, `View ${output.name}`, "view");
  const info = document.createElement("p"); info.className = "card-info";
  info.textContent = `${output.width} x ${output.height} / ${formatBytes(output.blob.size)}`;
  const buttons = document.createElement("div"); buttons.className = "card-actions";
  buttons.append(cardButton("View", "view"), cardButton("Download", "download"));
  card.append(heading, preview, info);
  if (output.metadataNote) {
    const note = document.createElement("p"); note.className = "card-info metadata-note";
    note.textContent = output.metadataNote;
    card.append(note);
  }
  card.append(buttons);
  output.element = card;
  return card;
}

function renderCards() {
  for (const item of state.items) {
    if (!item.element) $("image-list").append(createCard(item));
    const card = item.element;
    card.classList.toggle("active", item.id === state.activeId);
    card.classList.toggle("failed", !!item.error);
    card.querySelector("[data-select]").checked = item.selected;
    let text = "Original kept. Not processed yet.";
    if (item.error) text = item.error;
    else if (item.output) {
      const { blob, width, height } = item.output;
      const percent = Math.round((1 - blob.size / item.file.size) * 100);
      text = `${width} x ${height} / ${formatBytes(blob.size)} (${Math.abs(percent)}% ${percent >= 0 ? "smaller" : "larger"}).`;
      if (item.faceScan !== null || item.covers.length) text += " Review face covers.";
    }
    card.querySelector(".card-state").textContent = text;
  }
  const results = readyItems().map(item => item.output.element || createResultCard(item));
  const list = $("result-list");
  if (list.children.length !== results.length || results.some((card, index) => list.children[index] !== card)) {
    list.replaceChildren(...results);
  }
  $("empty").hidden = !!state.items.length;
  updateControls();
}

function invalidate(item) {
  if (item.output) {
    if (state.resultPreviewId === item.id) $("result-dialog").close();
    item.output.element?.remove();
    releaseUrl(item.output.url); releaseUrl(item.output.thumbnail);
  }
  item.output = null; item.error = "";
  if (item === active()) clearMetadata();
}

function settingsChanged() {
  const wasResult = state.resultView;
  for (const item of state.items) invalidate(item);
  state.resultView = false;
  renderCards(); renderCovers();
  if (wasResult) void renderPreview();
  if (state.items.length) status("Settings changed. Process your selected images to create updated results.");
}

async function renderPreview() {
  const item = active(), token = ++previewToken;
  $("inspector").hidden = !item;
  state.selectedCover = null;
  state.drawing = false;
  clearMetadata();
  if (!item) {
    $("preview").width = $("preview").height = 1;
    state.previewLoading = false; updateControls(); return;
  }
  $("active-name").textContent = item.file.name;
  $("active-info").textContent = `${item.width} x ${item.height} pixels / ${formatBytes(item.file.size)} original`;
  state.previewLoading = true;
  $("preview-surface").hidden = true;
  $("preview-hint").textContent = "Loading the local preview...";
  renderCovers(); updateControls();
  const output = state.resultView ? item.output : null;
  let bitmap;
  try {
    const preview = await imagePreview(output?.blob || item.file);
    bitmap = await createImageBitmap(preview.blob);
    if (token !== previewToken || item !== active()) return;
    const canvas = $("preview");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not draw the preview. Try a smaller image.");
    context.drawImage(bitmap, 0, 0);
    $("preview-surface").hidden = false;
    $("preview-hint").textContent = output ?
      `Processed result: ${output.width} x ${output.height}, ${formatBytes(output.blob.size)}. ${output.name}` :
      "Original image with solid covers overlaid. Covers are permanently painted into generated images, not saved as removable layers.";
  } catch (error) { if (token === previewToken) showError(error); }
  finally {
    bitmap?.close();
    if (token === previewToken) { state.previewLoading = false; renderCovers(); updateControls(); }
  }
}

function setActive(item, reveal = false) {
  state.activeId = item?.id || null;
  state.resultView = false;
  cancelGesture();
  renderCards();
  void renderPreview().then(() => {
    if (reveal && item === active()) $("inspector").scrollIntoView({ behavior: "auto", block: "start" });
  });
}

function renderCovers() {
  const item = active(), svg = $("covers");
  svg.replaceChildren();
  svg.hidden = !item || state.resultView || state.previewLoading;
  svg.classList.toggle("drawing", state.drawing);
  for (const [index, cover] of (item?.covers || []).entries()) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const key of ["x", "y", "width", "height"]) rect.setAttribute(key, cover[key] * 1000);
    rect.setAttribute("fill", $("cover-color").value);
    rect.dataset.cover = cover.id;
    rect.setAttribute("tabindex", state.busy ? "-1" : "0");
    rect.setAttribute("role", "button");
    rect.setAttribute("aria-label", `Cover ${index + 1}. Select to adjust or remove.`);
    rect.classList.toggle("selected", cover.id === state.selectedCover);
    svg.append(rect);
  }
  const cover = item?.covers.find(rect => rect.id === state.selectedCover);
  $("cover-editor").hidden = !cover;
  if (cover) for (const key of ["x", "y", "width", "height"]) $(`cover-${key}`).value = +(cover[key] * 100).toFixed(2);
  $("face-status").textContent = item ?
    `${item.covers.length} solid cover${item.covers.length === 1 ? "" : "s"}. ${item.faceScan === null ? "Automatic detection has not run." :
      `The last scan found ${item.faceScan} face${item.faceScan === 1 ? "" : "s"}.`} Detection can miss faces; review this image before sharing.` :
    "Face detection can miss people. Review every image before sharing.";
  updateControls();
}

function changeCovers(item, covers, selectedId = null) {
  covers.forEach(validateCover);
  item.coverHistory.push(item.covers.map(cover => ({ ...cover })));
  if (item.coverHistory.length > 20) item.coverHistory.shift();
  item.covers = covers;
  invalidate(item);
  state.selectedCover = selectedId;
  if (state.resultView) {
    state.resultView = false;
    void renderPreview().then(() => { state.selectedCover = selectedId; renderCovers(); });
  } else renderCovers();
  renderCards();
  status("Face covers updated. Process the image again before downloading.");
}

function removeItems(items) {
  const ids = new Set(items.map(item => item.id));
  for (const item of items) {
    invalidate(item); releaseUrl(item.thumbnail); item.element?.remove();
  }
  state.items = state.items.filter(item => !ids.has(item.id));
  if (!active()) setActive(state.items[0]);
  renderCards();
  status("Images removed from this tab. Original files and completed downloads have not changed.");
}

async function addFiles(files, signal) {
  if (!files.length) return;
  if (state.items.length + files.length > LIMITS.files) throw new Error("Keep at most 100 images in one batch. Remove some images first.");
  const total = [...state.items.map(item => item.file), ...files].reduce((sum, file) => sum + file.size, 0);
  if (total > LIMITS.totalBytes) throw new Error("The batch is larger than 256 MB. Add fewer images.");
  const errors = [];
  let count = 0;
  try {
    for (const file of files) {
      checkAbort(signal);
      status(`Reading ${file.name} locally...`);
      try {
        if (!file.size || file.size > LIMITS.fileBytes) throw new Error("Choose a non-empty image smaller than 50 MB.");
        const type = await sniffType(file);
        const preview = await imagePreview(file, 300, signal);
        checkAbort(signal);
        const item = { id: String(++sequence), file, type, width: preview.width, height: preview.height,
          thumbnail: objectUrl(preview.blob), selected: true, covers: [], coverHistory: [], faceScan: null,
          backgroundMask: null, output: null, error: "", element: null, metadata: null };
        state.items.push(item); count++;
        state.activeId ||= item.id;
        renderCards();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        errors.push(`${file.name}: ${error.message}`);
      }
      await nextFrame();
    }
    status(`Added ${count} image${count === 1 ? "" : "s"}. Select an image to inspect GPS, metadata, or face covers.`);
    if (errors.length) showError(new Error(errors.join("\n")));
  } finally { renderCards(); await renderPreview(); }
}

function numberValue(id, min, max, integer = false) {
  const input = $(id), value = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    input.focus({ preventScroll: true });
    throw new Error(`${input.labels[0]?.textContent || id} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

function settings() {
  const resize = $("resize").checked ? {
    width: $("width").value.trim() ? numberValue("width", 1, LIMITS.dimension, true) : null,
    height: $("height").value.trim() ? numberValue("height", 1, LIMITS.dimension, true) : null,
    upscale: $("upscale").checked,
  } : null;
  if (resize && resize.width === null && resize.height === null) throw new Error("Enter a resize width or height.");
  const targetBytes = $("target").checked ? Math.floor(numberValue("target-size", 1, 524288) * Number($("target-unit").value)) : null;
  if (targetBytes !== null && targetBytes > LIMITS.resultsBytes) throw new Error("The target size cannot exceed 512 MB per image.");
  const kind = $("watermark-kind").value;
  const watermark = { kind, text: $("watermark-text").value.trim(), color: $("watermark-color").value,
    opacity: numberValue("watermark-opacity", 5, 100) / 100, size: kind === "none" ? 6 : numberValue("watermark-size", 1, 80),
    position: $("watermark-position").value };
  if (kind === "text" && !watermark.text) throw new Error("Enter your watermark text.");
  if (kind === "logo" && !logoFile) throw new Error("Choose a logo image for the watermark.");
  return { format: $("format").value, quality: numberValue("quality", 5, 100) / 100, resize, targetBytes,
    allowShrink: $("allow-shrink").checked, background: $("background").checked, autoFaces: $("auto-faces").checked,
    coverColor: $("cover-color").value, neutralNames: $("neutral-names").checked, removeMetadata: $("remove-metadata").checked, watermark };
}

async function detectFaces(item, signal, force = false) {
  if (item.faceScan !== null && !force) return;
  const pixels = await imagePixels(item.file, signal);
  const found = await ai.run("faces", pixels, signal, status);
  checkAbort(signal);
  const manual = item.covers.filter(cover => cover.source !== "auto");
  const covers = [...manual, ...found.map(cover => ({ ...validateCover(cover), id: String(++coverSequence), source: "auto" }))];
  item.faceScan = found.length;
  changeCovers(item, covers);
}

async function processBatch(signal) {
  const chosen = selectedItems();
  if (!chosen.length) throw new Error("Select an image to process.");
  const options = settings();
  let logo, completed = 0;
  const errors = [];
  $("progress").hidden = false; $("progress").max = chosen.length; $("progress").value = 0;
  try {
    if (options.watermark.kind === "logo") logo = await decodeImage(logoFile);
    for (const [index, item] of chosen.entries()) {
      checkAbort(signal);
      invalidate(item); renderCards();
      status(`Processing ${index + 1} of ${chosen.length}: ${item.file.name}`);
      try {
        if (options.autoFaces) await detectFaces(item, signal);
        if (options.background && !item.backgroundMask) {
          item.backgroundMask = await ai.run("background", await imagePixels(item.file, signal), signal, status);
        }
        checkAbort(signal);
        let metadataNote = "";
        const preserveMetadata = options.removeMetadata ? null : async (output, width, height) => {
          const kept = await metadataWriter.run("copy", { source: item.file, output, width, height }, signal, status);
          metadataNote = kept.note;
          return kept.blob;
        };
        const result = await processImage(item, options, logo, signal, preserveMetadata);
        checkAbort(signal);
        const total = readyItems().reduce((sum, entry) => sum + entry.output.blob.size, 0) + result.blob.size;
        if (total > LIMITS.resultsBytes) throw new Error("Prepared images exceed 512 MB. Download a smaller batch or resize/compress more.");
        const extension = result.type === "image/jpeg" ? "jpg" : result.type.slice(6);
        const base = options.neutralNames ? `image-${String(state.items.indexOf(item) + 1).padStart(3, "0")}.${extension}` :
          safeFilename(item.file.name, extension);
        const name = uniqueFilename(base, new Set(readyItems().map(entry => entry.output.name.toLowerCase())));
        const thumbnail = await imagePreview(result.blob, 300, signal);
        checkAbort(signal);
        item.output = { ...result, name, url: objectUrl(result.blob), thumbnail: objectUrl(thumbnail.blob), metadataNote, metadata: null, element: null };
        completed++;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        item.error = error.message;
        if (error.name === "ModelLoadError" || error.name === "MetadataLoadError") throw error;
        errors.push(`${item.file.name}: ${error.message}`);
      }
      $("progress").value = index + 1;
      renderCards();
      await nextFrame();
    }
    const metadataStatus = options.removeMetadata ? "Original metadata was not copied." :
      "Supported metadata was kept, including GPS if present. Old embedded previews were not copied.";
    status(`Prepared ${completed} of ${chosen.length} selected images. ${errors.length ? `${errors.length} failed; see the errors below. ` : ""}${metadataStatus} Review faces and cutout edges before sharing.`);
    if (errors.length) showError(new Error(errors.join("\n")));
  } finally {
    logo?.close();
    state.resultView = !!active()?.output;
    await renderPreview();
    if (completed) $("results").scrollIntoView({ behavior: "auto", block: "start" });
  }
}

async function inspectMetadata(processed, signal) {
  const item = active();
  if (!item) throw new Error("Choose an image to inspect.");
  const owner = processed ? item.output : item;
  if (!owner) throw new Error("Process this image before inspecting its result metadata.");
  const label = processed ? (owner.metadataRemoved ? "Result (metadata removed)" : "Result (metadata kept)") : "Original";
  $("metadata-details").open = true;
  const token = ++metadataToken;
  $("metadata-summary").textContent = `Reading ${processed ? "result" : "original"} metadata locally...`;
  $("metadata").textContent = "";
  try {
    if (!owner.metadata) {
      const tags = await readMetadata(processed ? owner.blob : item.file);
      checkAbort(signal);
      owner.metadata = { summary: gpsSummary(tags), text: metadataText(tags) };
    }
    if (token !== metadataToken || active() !== item) return;
    $("metadata-summary").textContent = `${label}: ${owner.metadata.summary}`;
    $("metadata").textContent = owner.metadata.text;
    status("Metadata read locally. No location lookup or external request was made.");
  } catch (error) {
    if (token === metadataToken) $("metadata-summary").textContent = "Metadata could not be fully read. Do not assume this image has no GPS or other private tags.";
    throw error;
  }
}

async function downloadZip(signal) {
  const items = readyItems();
  if (!items.length) throw new Error("Process some images before downloading a ZIP.");
  await import("./vendor/jszip.min.js");
  checkAbort(signal);
  const zip = new globalThis.JSZip();
  for (const item of items) zip.file(item.output.name, item.output.blob);
  $("progress").hidden = false; $("progress").max = 100; $("progress").value = 0;
  const blob = await new Promise((resolve, reject) => {
    const parts = [], stream = zip.generateInternalStream({ type: "uint8array", compression: "STORE", streamFiles: true });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      stream.pause();
      if (error) { parts.length = 0; reject(error); }
      else resolve(new Blob(parts, { type: "application/zip" }));
    };
    const abort = () => finish(new DOMException("Cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (part, metadata) => {
      if (!settled) { parts.push(part); $("progress").value = metadata.percent; }
    }).on("error", finish).on("end", () => finish());
    if (signal.aborted) abort(); else stream.resume();
  });
  checkAbort(signal);
  download(blob, "image-utilities.zip");
  status(`ZIP created with all ${items.length} prepared result${items.length === 1 ? "" : "s"}. Originals and metadata reports are not included.`);
}

function downloadOne(item) {
  if (!item?.output) throw new Error("Process this image first.");
  download(item.output.blob, item.output.name);
  status("Processed image downloaded. Your original file was not changed.");
}

function setResultZoom(actualSize) {
  $("result-viewport").classList.toggle("actual-size", actualSize);
  $("result-zoom").textContent = actualSize ? "Fit to window" : "Actual size (100%)";
  $("result-viewport").scrollTo(0, 0);
}

function showResult(item) {
  if (!item?.output) throw new Error("Process this image first.");
  const output = item.output;
  state.resultPreviewId = item.id;
  $("result-title").textContent = output.name;
  $("result-details").textContent = `${output.width} x ${output.height} pixels / ${formatBytes(output.blob.size)}`;
  $("result-full-image").hidden = false;
  $("result-full-image").alt = `Processed image: ${output.name}`;
  $("result-full-image").src = output.url;
  $("result-image-error").hidden = true;
  setResultZoom(false);
  $("result-dialog").showModal();
  updateControls();
}

function point(event) {
  const bounds = $("covers").getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
}

function cancelGesture() {
  if (gesture && $("covers").hasPointerCapture(gesture.pointerId)) $("covers").releasePointerCapture(gesture.pointerId);
  gesture = null;
  $("covers").querySelector(".draft")?.remove();
}

$("covers").addEventListener("pointerdown", event => {
  if (state.busy || state.previewLoading || state.resultView || event.button !== 0) return;
  if (!state.drawing) {
    const id = event.target.dataset.cover;
    if (id) { state.selectedCover = id; renderCovers(); }
    return;
  }
  event.preventDefault();
  const start = point(event);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.classList.add("draft"); rect.setAttribute("fill", $("cover-color").value);
  $("covers").append(rect);
  gesture = { pointerId: event.pointerId, start, rect, item: active() };
  $("covers").setPointerCapture(event.pointerId); updateControls();
});
$("covers").addEventListener("pointermove", event => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const end = point(event), start = gesture.start;
  gesture.cover = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
  for (const key of ["x", "y", "width", "height"]) gesture.rect.setAttribute(key, gesture.cover[key] * 1000);
});
$("covers").addEventListener("pointerup", event => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const { cover, item } = gesture;
  cancelGesture(); state.drawing = false;
  if (!cover || cover.width * item.width < 2 || cover.height * item.height < 2) {
    status("No cover added. Drag a rectangle over the area you want to hide."); renderCovers(); return;
  }
  const id = String(++coverSequence);
  action(() => changeCovers(item, [...item.covers, { ...cover, id, source: "manual" }], id));
});
$("covers").addEventListener("pointercancel", () => { cancelGesture(); state.drawing = false; renderCovers(); });
$("covers").addEventListener("keydown", event => {
  if (state.busy) return;
  if ((event.key === "Enter" || event.key === " ") && event.target.dataset.cover) {
    event.preventDefault(); state.selectedCover = event.target.dataset.cover; renderCovers();
    $("cover-x").focus({ preventScroll: true });
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("result-dialog").open && (gesture || state.drawing)) {
    event.preventDefault(); cancelGesture(); state.drawing = false; renderCovers(); status("Drawing cancelled.");
  }
});
window.addEventListener("blur", () => { if (gesture) { cancelGesture(); state.drawing = false; renderCovers(); } });

$("add-files").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", () => {
  const files = Array.from($("files").files); $("files").value = "";
  if (files.length) void task("Reading images locally...", signal => addFiles(files, signal));
});
document.addEventListener("dragover", event => {
  if (!Array.from(event.dataTransfer.types).includes("Files")) return;
  event.preventDefault();
  if (!state.busy) document.querySelector(".import-panel").classList.add("drag-over");
});
document.addEventListener("dragleave", event => { if (!event.relatedTarget) document.querySelector(".import-panel").classList.remove("drag-over"); });
document.addEventListener("drop", event => {
  event.preventDefault(); document.querySelector(".import-panel").classList.remove("drag-over");
  if (!state.busy && event.dataTransfer.files.length) void task("Reading dropped images locally...", signal => addFiles(Array.from(event.dataTransfer.files), signal));
});
$("image-list").addEventListener("change", event => {
  if (!event.target.matches("[data-select]") || state.busy) return;
  const item = state.items.find(entry => entry.id === event.target.closest("[data-id]").dataset.id);
  item.selected = event.target.checked; updateControls();
});
$("image-list").addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled || state.busy) return;
  const item = state.items.find(entry => entry.id === button.closest("[data-id]").dataset.id);
  action(() => {
    if (button.dataset.action === "inspect") setActive(item, true);
    if (button.dataset.action === "download") downloadOne(item);
    if (button.dataset.action === "remove") removeItems([item]);
  });
});
$("result-list").addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled || state.busy) return;
  const item = state.items.find(entry => entry.id === button.closest("[data-id]").dataset.id);
  action(() => {
    if (button.dataset.action === "view") showResult(item);
    if (button.dataset.action === "download") downloadOne(item);
  });
});
$("close-result").addEventListener("click", () => $("result-dialog").close());
$("result-dialog").addEventListener("close", () => {
  if ($("result-dialog").open) return;
  state.resultPreviewId = null;
  $("result-full-image").removeAttribute("src");
  $("result-full-image").alt = "";
  $("result-title").textContent = "";
  $("result-details").textContent = "";
  $("result-image-error").hidden = true;
  setResultZoom(false);
  updateControls();
});
$("result-full-image").addEventListener("error", () => {
  if (!$("result-dialog").open) return;
  $("result-full-image").hidden = true;
  $("result-image-error").hidden = false;
  updateControls();
});
$("result-zoom").addEventListener("click", () => action(() => setResultZoom(!$("result-viewport").classList.contains("actual-size"))));
$("download-preview").addEventListener("click", () => action(() => downloadOne(viewed())));
$("select-all").addEventListener("click", () => action(() => { for (const item of state.items) item.selected = true; renderCards(); }));
$("select-none").addEventListener("click", () => action(() => { for (const item of state.items) item.selected = false; renderCards(); }));
$("remove-selected").addEventListener("click", () => action(() => removeItems(selectedItems())));
$("clear").addEventListener("click", () => action(() => {
  removeItems([...state.items]);
  ai.close(); metadataWriter.close();
  logoFile = null; $("watermark-logo").value = ""; $("logo-name").textContent = "A transparent PNG works well.";
  for (const timer of downloadTimers) clearTimeout(timer);
  downloadTimers.clear();
  for (const url of [...urls]) releaseUrl(url);
  clearMetadata(); clearError();
  status("Images, metadata, covers, results, and the logo have been cleared from this tab.");
}));
$("settings").addEventListener("input", event => {
  if (!state.busy && event.target.type !== "file") settingsChanged();
});
$("watermark-logo").addEventListener("change", () => {
  const file = $("watermark-logo").files[0];
  logoFile = null;
  settingsChanged();
  if (!file) return;
  void task("Reading the watermark logo locally...", async signal => {
    if (file.size > LIMITS.fileBytes) throw new Error("Choose a logo smaller than 50 MB.");
    await sniffType(file);
    const image = await decodeImage(file); image.close(); checkAbort(signal);
    logoFile = file; $("logo-name").textContent = file.name; status("Logo ready for batch watermarking.");
  });
});
$("process").addEventListener("click", () => task("Preparing the selected images...", processBatch));
$("download-zip").addEventListener("click", () => task("Creating a ZIP locally...", downloadZip));
$("download-one").addEventListener("click", () => action(() => downloadOne(active())));
$("cancel").addEventListener("click", () => {
  state.controller?.abort(); status("Cancelling. Any current browser encoding step will finish first..."); updateControls();
});
$("view-original").addEventListener("click", () => action(() => { state.resultView = false; void renderPreview(); }));
$("view-result").addEventListener("click", () => action(() => { state.resultView = true; void renderPreview(); }));
$("detect-faces").addEventListener("click", () => task("Finding faces on this device...", async signal => {
  const item = active();
  await detectFaces(item, signal, true);
  state.resultView = false;
  await renderPreview();
  status(`Detected ${item.faceScan} face${item.faceScan === 1 ? "" : "s"}. Review and correct the solid covers before processing.`);
}));
$("draw-cover").addEventListener("click", () => action(() => {
  if (state.resultView) {
    state.resultView = false;
    void renderPreview().then(() => { state.drawing = true; renderCovers(); });
  } else { state.drawing = !state.drawing; renderCovers(); }
  status("Drag a rectangle on the image to cover a face or private detail. Escape cancels.");
}));
$("add-cover").addEventListener("click", () => action(() => {
  const id = String(++coverSequence), item = active();
  changeCovers(item, [...item.covers, { id, source: "manual", x: .35, y: .35, width: .3, height: .3 }], id);
  $("cover-x").focus({ preventScroll: true });
}));
$("apply-cover").addEventListener("click", () => action(() => {
  const item = active();
  const values = Object.fromEntries(["x", "y", "width", "height"].map(key => [key, numberValue(`cover-${key}`, key === "x" || key === "y" ? 0 : .01, 100) / 100]));
  validateCover(values);
  changeCovers(item, item.covers.map(cover => cover.id === state.selectedCover ? { ...cover, ...values, source: "manual" } : cover), state.selectedCover);
}));
$("delete-cover").addEventListener("click", () => action(() => changeCovers(active(), active().covers.filter(cover => cover.id !== state.selectedCover))));
$("clear-covers").addEventListener("click", () => action(() => changeCovers(active(), [])));
$("undo-cover").addEventListener("click", () => action(() => {
  const item = active(); item.covers = item.coverHistory.pop(); invalidate(item); state.selectedCover = null;
  state.resultView = false; renderCovers(); renderCards(); void renderPreview(); status("Last cover edit undone. Process again to update the result.");
}));
$("read-original-metadata").addEventListener("click", () => task("Reading original metadata locally...", signal => inspectMetadata(false, signal)));
$("read-result-metadata").addEventListener("click", () => task("Inspecting result metadata...", signal => inspectMetadata(true, signal)));
$("metadata-details").addEventListener("toggle", () => {
  if ($("metadata-details").open && active() && !$("metadata").textContent && !state.busy) {
    void task("Reading original metadata locally...", signal => inspectMetadata(false, signal));
  }
});
window.addEventListener("beforeunload", event => {
  if (state.busy) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", event => {
  state.controller?.abort(); ai.close(); metadataWriter.close();
  if (!event.persisted) for (const url of [...urls]) releaseUrl(url);
});

if (!window.createImageBitmap || !window.Worker || !window.WebAssembly) {
  showError(new Error("Use a current Chrome, Edge, Firefox, or Safari browser with image decoding, Web Workers, and WebAssembly enabled."));
  status("This browser is missing a required image feature.");
} else {
  updateControls();
  $("app-version").textContent = `v${APP_VERSION} (ready)`;
  status("Ready. Add images; all processing and metadata inspection stay on your device.");
}
