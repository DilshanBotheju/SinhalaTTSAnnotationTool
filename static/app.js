"use strict";

const $ = (id) => document.getElementById(id);

const FIELD_INPUTS = ["f-sinhala", "f-roman", "f-notes"].map($);
const STATUS_LABELS = {
  all: "All",
  pending: "Pending",
  approved: "Approved",
  needs_review: "Needs review",
  rejected: "Rejected",
  unlisted: "Not in CSV",
};
const CONTEXT_PAD_SEC = 2;
const DURATION_TOLERANCE_SEC = 0.05;

const state = {
  ds: null,          // dataset detail from /api/dataset
  items: [],         // [{kind: "row"|"unlisted", clip, row?}]
  visible: [],       // items after filter + search
  filter: "all",
  query: "",
  current: null,     // clip filename
  dirty: false,
  loadToken: 0,
  clipVersion: {},   // clip -> counter, bumped when a clip is re-cut so audio reloads
};

// Boundary editor state. Times are on the segment's own timeline (see /api/segment).
const trim = {
  buf: null,         // decoded AudioBuffer of the segment (clip + context)
  info: null,        // {mode, segment_start, source_duration, sel_start, sel_end}
  peaks: null,
  sel: [0, 0],       // current handle positions
  drag: null,        // 0 = start handle, 1 = end handle
  source: null,      // playing AudioBufferSourceNode
  playStart: 0,      // audioCtx time when playback began
  playFrom: 0,
  rate: 1,
  token: 0,
};
const MIN_CLIP_SEC = 0.2;
const HANDLE_GRAB_PX = 10;

const audio = $("audio");
const rawAudio = $("raw-audio");
const canvas = $("wave");
let audioCtx = null;
let peaks = null;
let rawStopAt = null;

// ------------------------------------------------------------------ helpers

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function audioUrl(kind, file) {
  const q = new URLSearchParams({ id: state.ds.id, kind, file });
  return `/audio?${q}`;
}

function clipUrl(clip) {
  return `${audioUrl("clips", clip)}&v=${state.clipVersion[clip] || 0}`;
}

function clipNumber(name) {
  const m = name.match(/_(\d+[a-z]?)\.\w+$/);
  return m ? m[1] : "";
}

function statusOf(item) {
  if (item.kind === "unlisted") return "unlisted";
  return item.row.annotation_status || "pending";
}

function currentItem() {
  return state.items.find((i) => i.clip === state.current) || null;
}

function setSaveState(text, isError = false) {
  const el = $("save-state");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ------------------------------------------------------------------ loading

async function loadDatasets() {
  const list = await api("/api/datasets");
  const sel = $("dataset");
  sel.innerHTML = "";
  if (!list.length) {
    $("empty").textContent = "No datasets found. Put folders containing metadata.csv + clips/ under data/.";
    return;
  }
  for (const d of list) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.id.split("/").pop()}  (${d.rows} rows, ${d.clips} clips)`;
    opt.title = d.id;
    sel.appendChild(opt);
  }
  const last = recall("dataset");
  if (last && list.some((d) => d.id === last)) sel.value = last;
  await loadDataset(sel.value);
}

async function loadDataset(id) {
  if (state.dirty) await saveFields();
  state.ds = await api(`/api/dataset?id=${encodeURIComponent(id)}`);
  store("dataset", id);
  rebuildItems();
  rawAudio.removeAttribute("src");
  if (state.ds.raw_audio) rawAudio.src = audioUrl("raw_audio", state.ds.raw_audio);

  render();
  setSaveState("Saves to annotations/");
  $("save-state").title = `Annotations are saved to ${state.ds.output}`;
  const lastClip = recall(`clip:${id}`);
  const first = state.items.find((i) => i.clip === lastClip)
    || state.items.find((i) => statusOf(i) === "pending")
    || state.items[0];
  if (first) select(first.clip);
}

function rebuildItems() {
  const rows = state.ds.rows.map((row) => ({ kind: "row", clip: row.clip_filename, row }));
  const unlisted = state.ds.unlisted.map((clip) => ({ kind: "unlisted", clip }));
  state.items = rows.concat(unlisted).sort((a, b) => a.clip.localeCompare(b.clip));
}

// ------------------------------------------------------------------ rendering

function render() {
  renderProgress();
  renderFilters();
  renderList();
}

function counts() {
  const c = { all: state.items.length, pending: 0, approved: 0, needs_review: 0, rejected: 0, unlisted: 0 };
  for (const item of state.items) c[statusOf(item)] = (c[statusOf(item)] || 0) + 1;
  return c;
}

function renderProgress() {
  const c = counts();
  const total = state.ds.rows.length;
  const done = c.approved + c.rejected + c.needs_review;
  $("progress-fill").style.width = total ? `${(100 * done) / total}%` : "0";
  $("progress-text").textContent =
    `${done}/${total} reviewed · ✓ ${c.approved} · ⚑ ${c.needs_review} · ✕ ${c.rejected}` +
    (c.unlisted ? ` · ${c.unlisted} not in CSV` : "");
}

function renderFilters() {
  const c = counts();
  const box = $("filters");
  box.innerHTML = "";
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    if (key === "unlisted" && !c.unlisted) continue;
    const b = document.createElement("button");
    b.textContent = `${label} ${c[key] || 0}`;
    b.classList.toggle("active", state.filter === key);
    b.onclick = () => { state.filter = key; renderFilters(); renderList(); };
    box.appendChild(b);
  }
}

function renderList() {
  const q = state.query.toLowerCase();
  state.visible = state.items.filter((item) => {
    if (state.filter !== "all" && statusOf(item) !== state.filter) return false;
    if (!q) return true;
    const r = item.row || {};
    return [item.clip, r.transcript_sinhala, r.transcript_romanized, r.annotation_notes]
      .some((v) => v && v.toLowerCase().includes(q));
  });

  const ul = $("clip-list");
  ul.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const item of state.visible) {
    const li = document.createElement("li");
    li.dataset.clip = item.clip;
    li.classList.toggle("active", item.clip === state.current);

    const dot = document.createElement("span");
    dot.className = `dot ${statusOf(item)}`;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = clipNumber(item.clip);
    const txt = document.createElement("span");
    const text = item.row && item.row.transcript_sinhala;
    txt.className = text ? "txt" : "txt none";
    txt.textContent = text || (item.kind === "unlisted" ? "not in metadata.csv" : "empty transcript");

    li.append(dot, num, txt);
    li.onclick = () => select(item.clip);
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  ul.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}

function renderPanel() {
  const item = currentItem();
  $("empty").hidden = !!item;
  $("panel").hidden = !item;
  if (!item) return;

  const row = item.row;
  const status = statusOf(item);
  $("clip-index").textContent = `Clip #${clipNumber(item.clip)}`;
  $("clip-name").textContent = item.clip;
  const badge = $("clip-status");
  badge.textContent = STATUS_LABELS[status];
  badge.className = `badge ${status}`;

  const meta = $("meta");
  meta.innerHTML = "";
  const addMeta = (label, value) => {
    const span = document.createElement("span");
    span.append(`${label} `);
    const b = document.createElement("b");
    b.textContent = value;
    span.appendChild(b);
    meta.appendChild(span);
  };
  if (row) {
    if (row.start_sec !== "") addMeta("start", `${row.start_sec}s`);
    if (row.end_sec !== "") addMeta("end", `${row.end_sec}s`);
    addMeta("csv duration", `${row.duration_sec || "–"}s`);
  }
  const actual = document.createElement("span");
  actual.id = "actual-duration";
  meta.appendChild(actual);
  if (row && row.annotated_at) addMeta("last saved", row.annotated_at.replace("T", " "));
  if (row && row.clip_edited === "yes") addMeta("clip", "re-cut");
  const created = !!(row && row.created_from);
  if (created) addMeta("created from", `#${clipNumber(row.created_from)}`);

  $("unlisted-box").hidden = item.kind !== "unlisted";
  $("trim").hidden = item.kind === "unlisted";
  $("trim-edited").hidden = !(row && row.clip_edited);
  $("trim-edited").textContent = created ? "created" : "edited";
  $("trim-revert").hidden = created;
  $("trim-revert").disabled = !(row && row.clip_edited === "yes");
  $("trim-delete").hidden = !created;
  $("fields").hidden = item.kind === "unlisted";
  $("btn-context").disabled = !state.ds.raw_audio || !row || row.start_sec === "";

  for (const input of FIELD_INPUTS) {
    input.value = row ? row[input.dataset.col] || "" : "";
    input.closest(".field").classList.remove("dirty");
  }
  state.dirty = false;
  renderWarnings();
}

function renderWarnings(actualDuration) {
  const item = currentItem();
  if (!item) return;
  const row = item.row;
  const warnings = [];
  if (row) {
    if (row._has_audio === false) warnings.push("Audio file for this row is missing from clips/.");
    if (!row.transcript_sinhala) warnings.push("transcript_sinhala is empty.");
    if (!row.transcript_romanized) warnings.push("transcript_romanized is empty.");
    const start = parseFloat(row.start_sec), end = parseFloat(row.end_sec), dur = parseFloat(row.duration_sec);
    if (!isNaN(start) && !isNaN(end) && !isNaN(dur) && Math.abs(end - start - dur) > DURATION_TOLERANCE_SEC) {
      warnings.push(`end_sec − start_sec = ${(end - start).toFixed(2)}s but duration_sec = ${dur}s.`);
    }
    if (actualDuration && !isNaN(dur) && Math.abs(actualDuration - dur) > DURATION_TOLERANCE_SEC) {
      warnings.push(`Clip audio is ${actualDuration.toFixed(2)}s but duration_sec = ${dur}s.`);
    }
  }
  $("warnings").textContent = warnings.join("  ");
}

// ------------------------------------------------------------------ selection & audio

async function select(clip) {
  if (state.dirty && clip !== state.current) await saveFields();
  stopAll();
  state.current = clip;
  if (state.ds) store(`clip:${state.ds.id}`, clip);

  document.querySelectorAll("#clip-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.clip === clip);
  });
  document.querySelector("#clip-list li.active")?.scrollIntoView({ block: "nearest" });
  renderPanel();

  loadClipAudio(clip);
  if ($("autoplay").checked) audio.play().catch(() => {});
  loadSegment();
}

function loadClipAudio(clip) {
  const token = ++state.loadToken;
  peaks = null;
  drawWave();
  audio.src = clipUrl(clip);
  audio.playbackRate = parseFloat($("speed").value);
  loadPeaks(clip, token);
}

async function loadPeaks(clip, token) {
  try {
    const buf = await (await fetch(clipUrl(clip))).arrayBuffer();
    audioCtx = audioCtx || new AudioContext();
    const decoded = await audioCtx.decodeAudioData(buf);
    if (token !== state.loadToken) return;
    peaks = computePeaks(decoded.getChannelData(0), canvas.clientWidth || 800);
    drawWave();
  } catch (e) {
    if (token === state.loadToken) $("warnings").textContent = `Could not decode audio: ${e.message}`;
  }
}

function computePeaks(data, buckets) {
  const size = Math.max(1, Math.floor(data.length / buckets));
  const out = new Float32Array(buckets);
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    for (let j = i * size, end = Math.min(data.length, j + size); j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let i = 0; i < buckets; i++) out[i] /= max;
  return out;
}

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  if (!peaks) {
    ctx.fillStyle = css.getPropertyValue("--wave");
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  const step = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const x = i * step;
    const amp = Math.max(1, peaks[i] * (h / 2 - 4));
    ctx.fillStyle = css.getPropertyValue(x / w <= progress ? "--wave-played" : "--wave");
    ctx.fillRect(x, h / 2 - amp, Math.max(1, step - 0.5), amp * 2);
  }
}

function tick() {
  drawWave();
  $("time").textContent = `${(audio.currentTime || 0).toFixed(2)} / ${(audio.duration || 0).toFixed(2)} s`;
  if (!audio.paused) requestAnimationFrame(tick);
}

function togglePlay() {
  rawAudio.pause();
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function playContext() {
  const row = currentItem()?.row;
  if (!row || $("btn-context").disabled) return;
  const start = parseFloat(row.start_sec), end = parseFloat(row.end_sec);
  audio.pause();
  rawAudio.playbackRate = parseFloat($("speed").value);
  rawStopAt = end + CONTEXT_PAD_SEC;
  rawAudio.currentTime = Math.max(0, start - CONTEXT_PAD_SEC);
  rawAudio.play().catch((e) => { $("warnings").textContent = `Raw audio: ${e.message}`; });
}

function stopAll() {
  audio.pause();
  rawAudio.pause();
  stopTrim();
}

// ------------------------------------------------------------------ trim / extend

const trimCanvas = $("trim-wave");

async function loadSegment() {
  const item = currentItem();
  const token = ++trim.token;
  stopTrim();
  trim.buf = trim.peaks = trim.info = null;
  if (!item || item.kind !== "row" || !$("trim").open) return drawTrim();

  $("trim-hint").textContent = "Loading…";
  drawTrim();
  try {
    const q = new URLSearchParams({ id: state.ds.id, clip: item.clip, v: Date.now() });
    const res = await fetch(`/api/segment?${q}`);
    if (!res.ok) throw new Error((await res.json()).error);
    const info = JSON.parse(res.headers.get("X-Segment-Info"));
    const data = await res.arrayBuffer();
    audioCtx = audioCtx || new AudioContext();
    const buf = await audioCtx.decodeAudioData(data);
    if (token !== trim.token) return;

    trim.buf = buf;
    trim.info = info;
    trim.sel = [info.sel_start, info.sel_end];
    trim.peaks = computePeaks(buf.getChannelData(0), trimCanvas.clientWidth || 800);
    $("trim-hint").textContent = info.mode === "raw"
      ? `Showing the raw recording with ${(info.sel_start - info.segment_start).toFixed(1)}s of context before the clip. ` +
        "Drag the handles (or type times on the raw timeline) to trim or extend, then save."
      : "No raw audio timing for this clip, so it can only be trimmed. Times are relative to the clip.";
    updateTrimInputs();
  } catch (e) {
    if (token === trim.token) $("trim-hint").textContent = `Could not load segment: ${e.message}`;
  }
}

function segBounds() {
  const s = trim.info.segment_start;
  return [s, s + trim.buf.duration];
}

function timeToX(t) {
  const [a, b] = segBounds();
  return ((t - a) / (b - a)) * trimCanvas.clientWidth;
}

function xToTime(x) {
  const [a, b] = segBounds();
  return a + (x / trimCanvas.clientWidth) * (b - a);
}

function setHandle(which, t) {
  const [a, b] = segBounds();
  if (which === 0) trim.sel[0] = Math.min(Math.max(a, t), trim.sel[1] - MIN_CLIP_SEC);
  else trim.sel[1] = Math.max(Math.min(b, t), trim.sel[0] + MIN_CLIP_SEC);
  updateTrimInputs();
}

function updateTrimInputs() {
  const [s, e] = trim.sel;
  $("trim-start").value = s.toFixed(2);
  $("trim-end").value = e.toFixed(2);
  const was = trim.info.sel_end - trim.info.sel_start;
  const ds = s - trim.info.sel_start, de = e - trim.info.sel_end;
  const fmt = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}s`;
  const changed = Math.abs(ds) >= 0.005 || Math.abs(de) >= 0.005;
  $("trim-len").textContent = `length ${(e - s).toFixed(2)}s (was ${was.toFixed(2)}s)` +
    (changed ? ` · start ${fmt(ds)} · end ${fmt(de)}` : "");
  $("trim-save").disabled = !changed;
  $("trim-new").disabled = !changed;
  drawTrim();
}

function drawTrim() {
  const dpr = window.devicePixelRatio || 1;
  const w = trimCanvas.clientWidth, h = trimCanvas.clientHeight;
  trimCanvas.width = w * dpr;
  trimCanvas.height = h * dpr;
  const ctx = trimCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  if (!trim.peaks) {
    ctx.fillStyle = css.getPropertyValue("--wave");
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }

  const x0 = timeToX(trim.sel[0]), x1 = timeToX(trim.sel[1]);
  ctx.fillStyle = css.getPropertyValue("--accent-soft");
  ctx.fillRect(x0, 0, x1 - x0, h);

  const step = w / trim.peaks.length;
  for (let i = 0; i < trim.peaks.length; i++) {
    const x = i * step;
    const amp = Math.max(1, trim.peaks[i] * (h / 2 - 6));
    ctx.fillStyle = css.getPropertyValue(x >= x0 && x <= x1 ? "--wave-played" : "--wave");
    ctx.fillRect(x, h / 2 - amp, Math.max(1, step - 0.5), amp * 2);
  }

  // Original clip boundaries (dashed) so changes are visible.
  ctx.strokeStyle = css.getPropertyValue("--muted");
  ctx.setLineDash([4, 4]);
  for (const t of [trim.info.sel_start, trim.info.sel_end]) {
    const x = Math.round(timeToX(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draggable handles.
  ctx.fillStyle = css.getPropertyValue("--accent");
  for (const x of [x0, x1]) {
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.fillRect(x - 5, 0, 10, 12);
    ctx.fillRect(x - 5, h - 12, 10, 12);
  }

  if (trim.source) {
    const t = trim.playFrom + (audioCtx.currentTime - trim.playStart) * trim.rate;
    ctx.fillStyle = css.getPropertyValue("--review");
    ctx.fillRect(timeToX(t) - 1, 0, 2, h);
  }
}

function playTrim() {
  if (!trim.buf) return;
  if (trim.source) return stopTrim();
  audio.pause();
  rawAudio.pause();
  const [a] = segBounds();
  const src = audioCtx.createBufferSource();
  src.buffer = trim.buf;
  trim.rate = src.playbackRate.value = parseFloat($("speed").value);
  src.connect(audioCtx.destination);
  audioCtx.resume();
  src.start(0, trim.sel[0] - a, trim.sel[1] - trim.sel[0]);
  src.onended = () => { if (trim.source === src) stopTrim(); };
  trim.source = src;
  trim.playStart = audioCtx.currentTime;
  trim.playFrom = trim.sel[0];
  $("trim-play").textContent = "■ Stop";
  const loop = () => { if (trim.source === src) { drawTrim(); requestAnimationFrame(loop); } };
  loop();
}

function stopTrim() {
  if (!trim.source) return;
  const src = trim.source;
  trim.source = null;
  try { src.stop(); } catch { /* already stopped */ }
  $("trim-play").textContent = "▶ Play selection";
  drawTrim();
}

async function saveTrim() {
  const item = currentItem();
  if (!item || !trim.info) return;
  if (state.dirty && !(await saveFields())) return;
  stopAll();
  await applyClipChange("/api/crop", {
    clip_filename: item.clip,
    start_sec: trim.sel[0],
    end_sec: trim.sel[1],
  }, "Clip re-cut");
}

async function revertTrim() {
  const item = currentItem();
  if (!item || !confirm("Delete the re-cut clip and restore the original timings?")) return;
  if (state.dirty && !(await saveFields())) return;
  stopAll();
  await applyClipChange("/api/revert_clip", { clip_filename: item.clip }, "Reverted to original clip");
}

async function newClipFromSelection() {
  const item = currentItem();
  if (!item || !trim.info) return;
  if (state.dirty && !(await saveFields())) return;
  stopAll();
  setSaveState("Saving…");
  try {
    const row = await api(`/api/new_clip?id=${encodeURIComponent(state.ds.id)}`, {
      clip_filename: item.clip,
      start_sec: trim.sel[0],
      end_sec: trim.sel[1],
    });
    row._has_audio = true;
    state.ds.rows.push(row);
    rebuildItems();
    render();
    await select(row.clip_filename);
    setSaveState(`Created clip #${clipNumber(row.clip_filename)}`);
    $("f-sinhala").focus();
  } catch (e) {
    setSaveState(`Create failed: ${e.message}`, true);
  }
}

async function deleteCreatedClip() {
  const item = currentItem();
  if (!item || !item.row?.created_from) return;
  if (!confirm(`Delete clip #${clipNumber(item.clip)} and its row from the annotated CSV?`)) return;
  stopAll();
  const next = neighbour(1) || neighbour(-1);
  try {
    await api(`/api/delete_clip?id=${encodeURIComponent(state.ds.id)}`, { clip_filename: item.clip });
    state.ds.rows = state.ds.rows.filter((r) => r.clip_filename !== item.clip);
    state.dirty = false;
    rebuildItems();
    render();
    state.current = null;
    if (next) await select(next);
    else renderPanel();
    setSaveState(`Deleted clip #${clipNumber(item.clip)}`);
  } catch (e) {
    setSaveState(`Delete failed: ${e.message}`, true);
  }
}

async function applyClipChange(path, body, message) {
  setSaveState("Saving…");
  try {
    const saved = await api(`${path}?id=${encodeURIComponent(state.ds.id)}`, body);
    applySavedRow(saved);
    state.clipVersion[saved.clip_filename] = (state.clipVersion[saved.clip_filename] || 0) + 1;
    render();
    renderPanel();
    loadClipAudio(saved.clip_filename);
    loadSegment();
    setSaveState(message);
  } catch (e) {
    setSaveState(`Save failed: ${e.message}`, true);
  }
}

trimCanvas.addEventListener("pointerdown", (e) => {
  if (!trim.buf) return;
  const x = e.clientX - trimCanvas.getBoundingClientRect().left;
  const d0 = Math.abs(x - timeToX(trim.sel[0])), d1 = Math.abs(x - timeToX(trim.sel[1]));
  // Grab the nearest handle; clicking elsewhere moves the nearest handle there.
  trim.drag = d0 <= d1 ? 0 : 1;
  if (Math.min(d0, d1) > HANDLE_GRAB_PX) setHandle(trim.drag, xToTime(x));
  trimCanvas.setPointerCapture(e.pointerId);
});
trimCanvas.addEventListener("pointermove", (e) => {
  if (trim.drag === null) return;
  setHandle(trim.drag, xToTime(e.clientX - trimCanvas.getBoundingClientRect().left));
});
trimCanvas.addEventListener("pointerup", () => { trim.drag = null; });

$("trim-start").onchange = (e) => { if (trim.buf) setHandle(0, parseFloat(e.target.value)); };
$("trim-end").onchange = (e) => { if (trim.buf) setHandle(1, parseFloat(e.target.value)); };
$("trim-play").onclick = playTrim;
$("trim-reset").onclick = () => {
  if (!trim.info) return;
  trim.sel = [trim.info.sel_start, trim.info.sel_end];
  updateTrimInputs();
};
$("trim-save").onclick = saveTrim;
$("trim-revert").onclick = revertTrim;
$("trim-new").onclick = newClipFromSelection;
$("trim-delete").onclick = deleteCreatedClip;
$("trim").addEventListener("toggle", () => {
  store("trimOpen", $("trim").open ? "1" : "0");
  loadSegment();
});
$("trim").open = recall("trimOpen") === "1";

// ------------------------------------------------------------------ saving

function fieldValues() {
  const out = {};
  for (const input of FIELD_INPUTS) out[input.dataset.col] = input.value;
  return out;
}

function applySavedRow(saved) {
  const idx = state.ds.rows.findIndex((r) => r.clip_filename === saved.clip_filename);
  const merged = { ...state.ds.rows[idx], ...saved };
  state.ds.rows[idx] = merged;
  const item = state.items.find((i) => i.clip === saved.clip_filename);
  item.row = merged;
}

async function saveFields() {
  return postRow(undefined);
}

async function postRow(status) {
  const item = currentItem();
  if (!item || item.kind !== "row") return false;
  setSaveState("Saving…");
  try {
    const body = { clip_filename: item.clip, fields: fieldValues() };
    if (status) body.status = status;
    const saved = await api(`/api/row?id=${encodeURIComponent(state.ds.id)}`, body);
    applySavedRow(saved);
    state.dirty = false;
    FIELD_INPUTS.forEach((i) => i.closest(".field").classList.remove("dirty"));
    setSaveState(`Saved ${new Date().toLocaleTimeString()}`);
    return true;
  } catch (e) {
    setSaveState(`Save failed: ${e.message}`, true);
    return false;
  }
}

function neighbour(offset) {
  const list = state.visible;
  const idx = list.findIndex((i) => i.clip === state.current);
  if (idx === -1) return list[0]?.clip;
  return list[idx + offset]?.clip;
}

async function decide(status) {
  const item = currentItem();
  if (!item || item.kind !== "row") return;
  const next = neighbour(1);
  if (!(await postRow(status))) return;
  render();
  if (next) select(next);
  else renderPanel();
}

async function go(offset) {
  const target = neighbour(offset);
  if (target) await select(target);
}

async function addUnlisted() {
  const item = currentItem();
  if (!item || item.kind !== "unlisted") return;
  try {
    const row = await api(`/api/add_row?id=${encodeURIComponent(state.ds.id)}`, { clip_filename: item.clip });
    row._has_audio = true;
    state.ds.rows.push(row);
    state.ds.unlisted = state.ds.unlisted.filter((c) => c !== item.clip);
    rebuildItems();
    render();
    renderPanel();
    setSaveState("Row added");
    $("f-sinhala").focus();
  } catch (e) {
    setSaveState(`Add failed: ${e.message}`, true);
  }
}

// ------------------------------------------------------------------ events

$("dataset").onchange = (e) => loadDataset(e.target.value);
$("search").oninput = (e) => { state.query = e.target.value; renderList(); };
$("btn-play").onclick = togglePlay;
$("btn-context").onclick = playContext;
$("btn-approve").onclick = () => decide("approved");
$("btn-flag").onclick = () => decide("needs_review");
$("btn-reject").onclick = () => decide("rejected");
$("btn-save").onclick = saveFields;
$("btn-prev").onclick = () => go(-1);
$("btn-next").onclick = () => go(1);
$("btn-add").onclick = addUnlisted;

$("speed").onchange = (e) => {
  audio.playbackRate = rawAudio.playbackRate = parseFloat(e.target.value);
};

const autoplay = $("autoplay");
autoplay.checked = recall("autoplay") === "1";
autoplay.onchange = () => store("autoplay", autoplay.checked ? "1" : "0");

for (const input of FIELD_INPUTS) {
  input.addEventListener("input", () => {
    state.dirty = true;
    input.closest(".field").classList.add("dirty");
  });
}

audio.addEventListener("play", () => { $("btn-play").textContent = "❚❚ Pause"; tick(); });
audio.addEventListener("pause", () => { $("btn-play").textContent = "▶ Play"; tick(); });
audio.addEventListener("ended", () => { $("btn-play").textContent = "▶ Play"; tick(); });
audio.addEventListener("loadedmetadata", () => {
  const el = $("actual-duration");
  if (el) {
    el.textContent = "audio length ";
    const b = document.createElement("b");
    b.textContent = `${audio.duration.toFixed(2)}s`;
    el.appendChild(b);
  }
  renderWarnings(audio.duration);
  tick();
});

rawAudio.addEventListener("timeupdate", () => {
  if (rawStopAt !== null && rawAudio.currentTime >= rawStopAt) {
    rawAudio.pause();
    rawStopAt = null;
  }
});

canvas.addEventListener("click", (e) => {
  if (!audio.duration) return;
  const rect = canvas.getBoundingClientRect();
  audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  rawAudio.pause();
  audio.play().catch(() => {});
});

window.addEventListener("resize", () => {
  if (state.current) loadPeaks(state.current, state.loadToken);
  if (trim.buf) {
    trim.peaks = computePeaks(trim.buf.getChannelData(0), trimCanvas.clientWidth || 800);
    drawTrim();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); decide("approved"); return; }

  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const actions = {
      KeyP: togglePlay,
      KeyC: playContext,
      KeyT: () => {
        if ($("trim").hidden) return;
        if (!$("trim").open) $("trim").open = true;
        else playTrim();
      },
      KeyA: () => decide("approved"),
      KeyF: () => decide("needs_review"),
      KeyR: () => decide("rejected"),
      KeyS: saveFields,
      KeyN: () => go(1),
      KeyB: () => go(-1),
    };
    if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
    return;
  }

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.code === "Space" && !typing && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    togglePlay();
  }
});

loadDatasets().catch((e) => setSaveState(`Load failed: ${e.message}`, true));
