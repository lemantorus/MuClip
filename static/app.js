/* MuClip frontend — vanilla JS, no build step */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  videos: [],            // [{...video, clips:[...]}]
  currentId: null,       // selected video id
  words: [],             // words of current video
  selStart: null,        // word index
  selEnd: null,
  queue: [],             // [{start_word, end_word, title}]
  clipMode: null,        // clip id being previewed instead of full video
  editClip: null,        // {id, video_id, title} clip being range-edited
  startExtMs: 0,         // live start adjustment (ms; + = start earlier)
  endExtMs: 0,           // live end adjustment (ms; + = end later)
  baseStartMs: null,     // exact clip start_ms snapshot when entering edit mode
  baseEndMs: null,       // exact clip end_ms snapshot
  editBaseIsWords: false, // base derived from word selection (not stored clip ms)
  query: "",             // transcript search
  searchMatches: [],     // word indices matching current query
  searchIdx: 0,
  pollTimer: null,
  videoQuery: "",        // right-panel search by video title
  videoCollapsed: {},    // vid -> bool (collapsed)
  wordsBuiltFor: null,    // signature of words currently in DOM (avoid rebuilds)
  chat: { open: false, busy: false, history: [], timings: [] },
};

/* ================= helpers ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function wordTime(v, idx) { return (v.words[idx].start / 1000); }
function wordEndTime(v, idx) { return (v.words[idx].end / 1000); }

/* ================= video list (right panel) ================= */

function renderVideoList() {
  const wrap = $("#videoList");
  const q = state.videoQuery;
  const list = q
    ? state.videos.filter((v) => (v.title || "").toLowerCase().includes(q))
    : state.videos;
  $("#videoCount").textContent = q
    ? `${list.length}/${state.videos.length}`
    : state.videos.length;

  if (!state.videos.length) {
    wrap.innerHTML = `<div class="vi-title" style="color:var(--faint);padding:8px">No videos yet</div>`;
    return;
  }
  if (!list.length) {
    wrap.innerHTML = `<div class="video-empty">No videos match “${esc(q)}”</div>`;
    return;
  }

  wrap.innerHTML = list.map((v) => {
    const statusCls = v.status === "ready" ? "ready" : v.status === "error" ? "error" : "processing";
    const collapsed = !!state.videoCollapsed[v.id];

    const clips = (v.clips || []).map((c) => {
      const st = c.status === "ready" ? "ready" : c.status === "error" ? "error" : "cutting";
      const actions = c.status === "ready"
        ? `<div class="c-actions">
             <button class="btn tiny" data-act="watch-clip" data-vid="${v.id}" data-cid="${c.id}">▶ Watch</button>
             <button class="btn tiny" data-act="download-clip" data-cid="${c.id}" title="Download with a file name">⬇</button>
             <button class="btn tiny icon danger" data-act="del-clip" data-cid="${c.id}" title="Delete">✕</button>
           </div>`
        : `<span class="c-status ${st}">${c.status === "cutting" ? "✂ cutting…" : c.status}</span>`;
      return `<div class="vi-clip ${c.status !== "ready" ? "busy" : ""}">
        <span class="c-title" data-cid="${c.id}" data-vid="${v.id}"
              title="${esc(c.title)} · ${fmtTime(c.start_ms / 1000)} – ${fmtTime(c.end_ms / 1000)} — double-click to rename">${esc(c.title)}</span>
        ${actions}
      </div>`;
    }).join("");

    return `<div class="video-item ${v.id === state.currentId ? "active" : ""} ${collapsed ? "collapsed" : ""}" data-vid="${v.id}">
      <div class="vi-head">
        <button class="vi-chev" data-act="toggle-collapse" data-vid="${v.id}"
                title="${collapsed ? "Expand" : "Collapse"}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        ${v.thumbnail
          ? `<img class="vi-thumb" data-act="open" data-vid="${v.id}" src="/media/${v.thumbnail}" loading="lazy">`
          : `<div class="vi-thumb-ph" data-act="open" data-vid="${v.id}">♪</div>`}
        <div class="vi-meta">
          <div class="vi-title"><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a></div>
          <div class="vi-sub">
            <span class="badge ${statusCls}">${v.status}</span>
            <span>${fmtTime(v.duration)}</span>
            <span>${v.words?.length || 0} words</span>
            <span>${(v.scenes || []).length} scenes</span>
            <span>${(v.clips || []).length} clips</span>
          </div>
          ${v.error ? `<div class="vi-err">${esc(v.error)}</div>` : ""}
          ${v.llm_error ? `<div class="vi-err">${esc(v.llm_error)}</div>` : ""}
        </div>
      </div>
      <div class="vi-body ${collapsed ? "hidden" : ""}">
        <div class="vi-actions">
          <button class="btn small" data-act="open" data-vid="${v.id}">Open</button>
          <button class="btn small" data-act="reanalyze" data-vid="${v.id}">✨ Find scenes</button>
          <button class="btn small" data-act="download-video" data-vid="${v.id}" title="Download the full video">⬇ Video</button>
          <button class="btn small danger" data-act="del-video" data-vid="${v.id}">Delete video</button>
        </div>
        ${clips ? `<div class="vi-clips">${clips}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

/* ================= current video / player ================= */

function currentVideo() {
  return state.videos.find((v) => v.id === state.currentId) || null;
}

function setPlayerSrc(kind, id) {
  const p = $("#player");
  const src = kind === "clip"
    ? `/api/clips/${id}/stream`
    : `/api/videos/${id}/stream`;
  p.src = src;
}

function openVideo(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  state.currentId = id;
  state.words = v.words || [];
  state.selStart = null;
  state.selEnd = null;
  state.queue = [];
  state.clipMode = null;
  state.editClip = null;
  state.startExtMs = 0;
  state.endExtMs = 0;
  state.baseStartMs = null;
  state.baseEndMs = null;
  state.editBaseIsWords = false;
  state.wordsBuiltFor = null; // force DOM rebuild for new video
  state.query = "";
  state.searchMatches = [];
  state.searchIdx = 0;
  $("#searchInput").value = "";
  updateSearchInfo();
  renderEditBar();

  $("#emptyState").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#clipModeBar").classList.add("hidden");
  $("#transcriptCard").classList.remove("hidden");

  $("#videoTitle").textContent = v.title;
  $("#statusBadge").textContent = v.status;
  $("#statusBadge").className = "badge " + (v.status === "ready" ? "ready"
    : v.status === "error" ? "error" : "processing");

  setPlayerSrc("video", id);
  renderWords();
  renderQueue();
  renderVideoList();
  updateChatContext();
}

function renderWords(force) {
  const wrap = $("#words");
  const v = currentVideo();
  if (!v || !v.words.length) {
    if (state.wordsBuiltFor !== "empty") {
      wrap.innerHTML = `<div style="color:var(--faint);padding:8px;user-select:text">No transcript yet — words appear after transcription.</div>`;
      state.wordsBuiltFor = "empty";
    }
    return;
  }
  // Rebuild DOM only when the set of words changes (different video / refresh).
  const sig = `${v.id}:${v.words.length}:${v.words[0]?.start}`;
  if (force || state.wordsBuiltFor !== sig) {
    wrap.innerHTML = v.words.map((w, i) =>
      `<span class="word" data-i="${i}" title="${fmtTime(w.start / 1000)}">${esc(w.text)}</span>`
    ).join("");
    state.wordsBuiltFor = sig;
  }
  updateWordClasses();
}

/* Toggle selection / match classes in-place — no innerHTML rewrite, no flicker. */
function updateWordClasses() {
  const wrap = $("#words");
  const v = currentVideo();
  if (!v || !v.words.length) return;
  const a = Math.min(state.selStart ?? -1, state.selEnd ?? -1);
  const b = Math.max(state.selStart ?? -1, state.selEnd ?? -1);
  const matchSet = state.searchMatches.length ? new Set(state.searchMatches) : null;
  const curMatch = state.searchMatches[state.searchIdx];
  const r = extendedRangeMs();
  const useTime = !!(state.clipMode && (state.startExtMs !== 0 || state.endExtMs !== 0) && r);

  const kids = wrap.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (!el.classList || !el.classList.contains("word")) continue;
    let cls = "word";
    const sel = useTime
      ? (v.words[i].start < r.e && v.words[i].end > r.s)
      : (i >= a && i <= b);
    if (sel) cls += " sel";
    if (matchSet && matchSet.has(i)) {
      cls += i === curMatch ? " match cur" : " match";
    }
    if (el.className !== cls) el.className = cls;
  }
}

/* live preview range of the clip being edited.
   Base = stored clip ms (when no word selection) OR the selected word range.
   start = baseS − startExt, end = baseE + endExt. */
function extendedRangeMs() {
  const v = currentVideo();
  if (!state.editClip || !v) return null;
  const hasSel = state.selStart != null && state.selEnd != null;
  const sMin = hasSel ? Math.min(state.selStart, state.selEnd) : -1;
  const sMax = hasSel ? Math.max(state.selStart, state.selEnd) : -1;
  // If the user picked a new word range, that becomes the base (ext reset on drag).
  const baseS = sMin >= 0 ? v.words[sMin].start : (state.baseStartMs ?? 0);
  const baseE = sMax >= 0 ? v.words[sMax].end : (state.baseEndMs ?? 0);
  return {
    s: Math.max(0, Math.round(baseS - state.startExtMs)),
    e: Math.round(baseE + state.endExtMs),
  };
}

function signedAdj(ms) {
  return (ms > 0 ? "+" : "−") + (Math.abs(ms) / 1000).toFixed(3) + "s";
}

function fmtMs(ms) {
  const t = ms / 1000;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
}

/* selection: click first word, click second word (drag also works) */
let _dragging = false;

function initWordSelection() {
  const wrap = $("#words");

  const wordAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const w = el && el.closest ? el.closest(".word") : null;
    return w ? +w.dataset.i : null;
  };

  wrap.addEventListener("pointerdown", (e) => {
    const i = wordAt(e.clientX, e.clientY);
    if (i == null) return;
    _dragging = true;
    wrap.setPointerCapture(e.pointerId);
    state.selStart = i;
    state.selEnd = i;
    if (state.editClip) state.editBaseIsWords = true;
    updateWordClasses();
    renderEditBar();
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!_dragging) return;
    const i = wordAt(e.clientX, e.clientY);
    if (i != null) {
      state.selEnd = i;
      updateWordClasses();
      renderEditBar();
    }
  });

  const finish = (e) => {
    if (!_dragging) return;
    _dragging = false;
    try { wrap.releasePointerCapture(e.pointerId); } catch {}
    if (state.selStart != null && state.selEnd != null) {
      if (state.selStart > state.selEnd) [state.selStart, state.selEnd] = [state.selEnd, state.selStart];
    }
  };
  wrap.addEventListener("pointerup", finish);
  wrap.addEventListener("pointercancel", finish);
}

function clearSel() {
  state.selStart = null;
  state.selEnd = null;
  updateWordClasses();
}

/* preview: play exactly from start to end of selection */
let _previewStopAt = null;

function previewSelection() {
  const v = currentVideo();
  if (!v || state.selStart == null) return;
  const t0 = wordTime(v, state.selStart);
  const t1 = wordEndTime(v, state.selEnd);
  const p = $("#player");
  if (state.clipMode) { backToVideo(); }
  p.currentTime = t0;
  _previewStopAt = t1;
  p.play().catch(() => {});
}

const player = $("#player");
player.addEventListener("timeupdate", () => {
  if (_previewStopAt != null && player.currentTime >= _previewStopAt) {
    player.pause();
    _previewStopAt = null;
  }
  // live adjustment preview: pause at the adjusted (real-time) end
  if (state.clipMode && (state.startExtMs !== 0 || state.endExtMs !== 0)) {
    const r = extendedRangeMs();
    if (r && player.currentTime >= r.e / 1000 - 0.12 && !player.seeking) {
      player.pause();
    }
  }
});

player.addEventListener("pause", () => {
  _previewStopAt = null;
});

/* ================= cut queue ================= */

function addToQueue() {
  const v = currentVideo();
  if (!v || state.selStart == null) return;
  state.queue.push({
    start_word: state.selStart,
    end_word: state.selEnd,
    title: `Clip ${fmtTime(wordTime(v, state.selStart))}`,
  });
  renderQueue();
  toast(`Added to cut list (${state.queue.length} total)`);
}

function renderQueue() {
  const v = currentVideo();
  const card = $("#queueCard");
  const list = $("#queueList");
  $("#queueCount").textContent = state.queue.length ? `(${state.queue.length})` : "";
  if (!state.queue.length || !v) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  list.innerHTML = state.queue.map((q, i) => `
    <div class="queue-item">
      <span class="q-time">${fmtTime(wordTime(v, q.start_word))} – ${fmtTime(wordEndTime(v, q.end_word))}</span>
      <input type="text" value="${esc(q.title)}" data-q="${i}" data-act="qtitle">
      <button class="btn small" data-q="${i}" data-act="qcut">✂ Cut</button>
      <button class="btn icon" data-q="${i}" data-act="qdel">✕</button>
    </div>`).join("");
}

async function cutBetween(vid, startWord, endWord, title) {
  const c = await api(`/api/videos/${vid}/clips`, {
    method: "POST",
    body: JSON.stringify({ start_word: startWord, end_word: endWord, title }),
  });
  toast(`Cutting “${c.title}”…`);
  await refresh();
  startPolling();
}

async function analyzeScenes(vid) {
  await api(`/api/videos/${vid}/analyze`, { method: "POST" });
  toast("Analyzing with LLM…");
  await refresh();
  startPolling();
}

/* ================= clip preview mode ================= */

function watchClip(cid) {
  const clip = findClip(cid);
  if (!clip) return toast("Clip not found", true);
  if (clip.status !== "ready") return toast("Wait until the clip is ready", true);
  if (state.currentId !== clip.video_id) openVideo(clip.video_id);
  // select the clip's word range so the user sees its words and can adjust them
  state.editClip = { id: clip.id, video_id: clip.video_id, title: clip.title };
  state.baseStartMs = clip.start_ms ?? 0;
  state.baseEndMs = clip.end_ms ?? 0;
  state.editBaseIsWords = false;
  state.startExtMs = 0;
  state.endExtMs = 0;
  state.selStart = clip.start_word;
  state.selEnd = clip.end_word;
  state.clipMode = cid;
  setPlayerSrc("clip", cid);
  renderWords(true);
  renderEditBar();
  const el = $(`#words .word[data-i="${clip.start_word}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  $("#clipModeBar").classList.remove("hidden");
  $("#clipModeLabel").textContent = "Playing cut clip — its word range is selected: shrink or expand it, then Update or Add as new.";
  player.play().catch(() => {});
}

function backToVideo() {
  state.clipMode = null;
  const v = currentVideo();
  if (v) setPlayerSrc("video", v.id);
  $("#clipModeBar").classList.add("hidden");
}

$("#backToVideo").addEventListener("click", backToVideo);

/* ================= real-time start/end adjustment (live preview) ================= */

function setEndExt(nextMs) {
  const r = extendedRangeMs();
  // keep at least 200 ms between preview start and adjusted end
  const baseE = r ? r.e - state.endExtMs : 0;
  state.endExtMs = Math.max(Math.round(nextMs), r ? r.s + 200 - baseE : 0);
  onExtChanged();
}

function setStartExt(nextMs) {
  const r = extendedRangeMs();
  const baseS = r ? r.s + state.startExtMs : 0;
  // start must stay >= 0 and leave >= 200 ms before the preview end
  const lo = r ? baseS - r.e + 200 : 0;
  state.startExtMs = Math.max(Math.min(Math.round(nextMs), baseS), lo);
  onExtChanged();
}

function nudgeEndExt(deltaMs) { setEndExt(state.endExtMs + deltaMs); }
function nudgeStartExt(deltaMs) { setStartExt(state.startExtMs + deltaMs); }

/* Keep the number inputs in sync with the live adjustment state.
   + = start earlier / end later; − = trim. */
function syncExtFields() {
  const sa = $("#startAdj"), ea = $("#endAdj");
  if (!sa || !ea) return;
  if (document.activeElement !== sa) sa.value = (state.startExtMs / 1000).toFixed(1);
  if (document.activeElement !== ea) ea.value = (state.endExtMs / 1000).toFixed(1);
}

/* Parse a typed value (seconds, signed) -> ms, clamped to a sane range. */
function parseAdjInput(raw) {
  const v = parseFloat(raw);
  if (isNaN(v)) return 0;
  return Math.round(Math.max(-60, Math.min(60, v)) * 1000);
}

function onExtChanged() {
  const v = currentVideo();
  const adj = state.startExtMs !== 0 || state.endExtMs !== 0;
  updateWordClasses();
  renderEditBar();
  syncExtFields();
  if (!v || !state.clipMode) return;
  const wantFull = adj;
  const onFull = player.src.includes(`/api/videos/${v.id}/stream`);
  if (wantFull && !onFull) {
    // switch from the cut file to the source video so playback can run past the old
    // boundaries; keep the current listening position if the user is mid-playback
    const keepFrom = player.paused ? null : player.currentTime;
    setPlayerSrc("video", v.id);
    seekPreviewStart(keepFrom);
  } else if (!wantFull && onFull) {
    setPlayerSrc("clip", state.clipMode);
  }
}

function seekPreviewStart(keepFrom) {
  const r = extendedRangeMs();
  if (!r) return;
  const t = (keepFrom != null ? r.s / 1000 + keepFrom : r.s / 1000);
  const seek = () => {
    player.currentTime = t;
    if (keepFrom != null) player.play().catch(() => {});
  };
  if (player.readyState >= 1) seek();
  else player.addEventListener("loadedmetadata", seek, { once: true });
}

function playPreviewFromStart() {
  const v = currentVideo();
  if (!v || !state.clipMode) return;
  if (state.startExtMs === 0 && state.endExtMs === 0) {
    player.currentTime = 0; // clip file starts exactly at the range start
    player.play().catch(() => {});
    return;
  }
  const r = extendedRangeMs();
  if (!r) return;
  if (!player.src.includes(`/api/videos/${v.id}/stream`)) setPlayerSrc("video", v.id);
  seekPreviewStart(null);
}

/* direct binding: typing in the offset fields sets the live adjustment */
$("#startAdj").addEventListener("input", () => setStartExt(parseAdjInput($("#startAdj").value)));
$("#endAdj").addEventListener("input", () => setEndExt(parseAdjInput($("#endAdj").value)));

/* ================= actions (event delegation) ================= */

document.addEventListener("click", async (e) => {
  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const act = actEl.dataset.act;
    const vid = actEl.dataset.vid, cid = actEl.dataset.cid, sid = actEl.dataset.sid;
    try {
      if (act === "open") openVideo(vid);
      else if (act === "del-video") {
        if (!confirm("Delete this video and all its clips?")) return;
        await api(`/api/videos/${vid}`, { method: "DELETE" });
        if (state.currentId === vid) { state.currentId = null; location.reload(); }
        toast("Video deleted");
        await refresh();
      }
      else if (act === "reanalyze") { await analyzeScenes(vid); }
      else if (act === "del-clip") {
        await api(`/api/clips/${cid}`, { method: "DELETE" });
        if (state.clipMode === cid) backToVideo();
        toast("Clip deleted");
        await refresh();
      }
      else if (act === "watch-clip") { watchClip(cid); }
      else if (act === "update-clip") { await updateClipRange(); }
      else if (act === "add-edit-clip") { await addEditClipAsNew(); }
      else if (act === "cancel-edit") { cancelClipEdit(); }
      else if (act === "s-1") { nudgeStartExt(-1000); }
      else if (act === "s-05") { nudgeStartExt(-500); }
      else if (act === "s+05") { nudgeStartExt(500); }
      else if (act === "s+1") { nudgeStartExt(1000); }
      else if (act === "s-step-up") { nudgeStartExt(100); }
      else if (act === "s-step-down") { nudgeStartExt(-100); }
      else if (act === "e-1") { nudgeEndExt(-1000); }
      else if (act === "e-05") { nudgeEndExt(-500); }
      else if (act === "e+05") { nudgeEndExt(500); }
      else if (act === "e+1") { nudgeEndExt(1000); }
      else if (act === "e-step-up") { nudgeEndExt(100); }
      else if (act === "e-step-down") { nudgeEndExt(-100); }
      else if (act === "ext-play") { playPreviewFromStart(); }
      else if (act === "ext-reset") { setStartExt(0); setEndExt(0); }
      else if (act === "download-clip") { openDownloadDialog("clip", cid); }
      else if (act === "download-video") { openDownloadDialog("video", vid); }
      else if (act === "dl-cancel") { cancelDownloadDialog(); }
      else if (act === "toggle-collapse") {
        state.videoCollapsed[vid] = !state.videoCollapsed[vid];
        renderVideoList();
      }
    } catch (err) { toast(err.message, true); }
    return;
  }

  const qEl = e.target.closest("[data-q]");
  if (qEl && qEl.dataset.act) {
    const i = +qEl.dataset.q;
    try {
      if (qEl.dataset.act === "qdel") { state.queue.splice(i, 1); renderQueue(); }
      else if (qEl.dataset.act === "qcut") {
        const q = state.queue[i];
        await cutBetween(currentVideo().id, q.start_word, q.end_word, q.title);
        state.queue.splice(i, 1);
        renderQueue();
      }
    } catch (err) { toast(err.message, true); }
  }
});

$("#queueList").addEventListener("input", (e) => {
  if (e.target.dataset.act === "qtitle") {
    state.queue[+e.target.dataset.q].title = e.target.value;
  }
});

/* toolbar buttons */
$("#btnPreview").addEventListener("click", previewSelection);
$("#btnAddCut").addEventListener("click", () => {
  if (state.selStart == null) return toast("Select words first", true);
  addToQueue();
});
$("#btnCutNow").addEventListener("click", async () => {
  const v = currentVideo();
  if (!v || state.selStart == null) return toast("Select words first", true);
  try {
    await cutBetween(v.id, state.selStart, state.selEnd,
      `Clip ${fmtTime(wordTime(v, state.selStart))}`);
    clearSel();
    await refresh();
  } catch (err) { toast(err.message, true); }
});
$("#btnClearSel").addEventListener("click", clearSel);

$("#btnCutAll").addEventListener("click", async () => {
  const v = currentVideo();
  if (!v || !state.queue.length) return;
  try {
    for (const q of [...state.queue]) {
      await api(`/api/videos/${v.id}/clips`, {
        method: "POST",
        body: JSON.stringify({ start_word: q.start_word, end_word: q.end_word, title: q.title }),
      });
    }
    toast(`Cutting ${state.queue.length} clips…`);
    state.queue = [];
    renderQueue();
    await refresh();
    startPolling();
  } catch (err) { toast(err.message, true); }
});

/* ================= clip range editing ================= */

function findClip(cid) {
  for (const v of state.videos) {
    const c = (v.clips || []).find((x) => x.id === cid);
    if (c) return c;
  }
  return null;
}

function renderEditBar() {
  const bar = $("#editBar");
  if (!state.editClip) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  $("#editClipTitle").textContent = state.editClip.title;
  const r = extendedRangeMs();
  if (r) {
    const dur = ((r.e - r.s) / 1000).toFixed(3);
    const adj = [];
    if (state.startExtMs) adj.push(`start ${signedAdj(state.startExtMs)}`);
    if (state.endExtMs) adj.push(`end ${signedAdj(state.endExtMs)}`);
    $("#extInfo").innerHTML =
      `${fmtMs(r.s)} – ${fmtMs(r.e)} · <b>${dur}s</b>` +
      (adj.length ? ` <span class="adj">(${adj.join(" · ")})</span>` : "");
  }
}

async function updateClipRange() {
  if (!state.editClip) return;
  const r = extendedRangeMs();
  if (!r) return toast("Select a range first", true);
  const clipId = state.editClip.id;
  if (state.clipMode === clipId) backToVideo(); // clip is being re-cut, stop watching old file
  await api(`/api/clips/${clipId}/range`, {
    method: "POST",
    body: JSON.stringify({ start_ms: r.s, end_ms: r.e }),
  });
  const adj = [];
  if (state.startExtMs) adj.push(`start ${signedAdj(state.startExtMs)}`);
  if (state.endExtMs) adj.push(`end ${signedAdj(state.endExtMs)}`);
  toast(adj.length ? `Re-cutting clip (${adj.join(", ")})…` : "Re-cutting clip…");
  cancelClipEdit();
  await refresh();
  startPolling();
}

async function addEditClipAsNew() {
  const v = currentVideo();
  if (!state.editClip || !v) return;
  const r = extendedRangeMs();
  if (!r) return toast("Select a range first", true);
  await api(`/api/videos/${v.id}/clips`, {
    method: "POST",
    body: JSON.stringify({ start_ms: r.s, end_ms: r.e, title: `${state.editClip.title} (2)` }),
  });
  toast(`Cutting “${state.editClip.title} (2)”…`);
  cancelClipEdit();
  await refresh();
  startPolling();
}

function cancelClipEdit() {
  state.editClip = null;
  state.startExtMs = 0;
  state.endExtMs = 0;
  state.baseStartMs = null;
  state.baseEndMs = null;
  state.editBaseIsWords = false;
  syncExtFields();
  renderEditBar();
}

/* ================= download with file-name dialog ================= */

let dlPending = null; // {kind: "clip"|"video", id}

function openDownloadDialog(kind, id) {
  const clip = kind === "clip" ? findClip(id) : null;
  const v = kind === "video" ? state.videos.find((x) => x.id === id) : null;
  if (kind === "clip" && (!clip || clip.status !== "ready")) return toast("Clip is not ready", true);
  if (kind === "video" && !v) return toast("Video not found", true);
  const base = (kind === "clip" ? clip.title : v.title) || "clip";
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim() || "file";
  $("#dlName").value = `${safe}.mp4`;
  dlPending = { kind, id };
  $("#dlModal").classList.remove("hidden");
  $("#dlName").focus();
  $("#dlName").select();
}

function submitDownloadDialog() {
  if (!dlPending) return;
  let name = $("#dlName").value.trim();
  if (!name) name = "file.mp4";
  if (!/\.mp4$/i.test(name)) name += ".mp4";
  const { kind, id } = dlPending;
  const base = kind === "clip" ? `/api/clips/${id}/download` : `/api/videos/${id}/download`;
  $("#dlModal").classList.add("hidden");
  dlPending = null;
  window.location.href = `${base}?name=${encodeURIComponent(name)}`;
}

function cancelDownloadDialog() {
  $("#dlModal").classList.add("hidden");
  dlPending = null;
}

$("#dlOk").addEventListener("click", submitDownloadDialog);
$("#dlCancel").addEventListener("click", cancelDownloadDialog);
$("#dlName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitDownloadDialog();
  if (e.key === "Escape") cancelDownloadDialog();
});

/* ================= clip title: double-click to rename (auto-save) ================= */

function makeClipTitleEditable(el, cid) {
  const current = el.textContent.trim();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = current;
  input.spellcheck = false;
  el.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val && val !== current) {
      try {
        await api(`/api/clips/${cid}/title`, {
          method: "POST",
          body: JSON.stringify({ title: val }),
        });
        toast(`Renamed → ${val}`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
        refresh();
      }
    } else {
      refresh(); // restore the view without changes
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

$("#videoList").addEventListener("dblclick", (e) => {
  const t = e.target.closest(".c-title[data-cid]");
  if (t) {
    e.preventDefault();
    makeClipTitleEditable(t, t.dataset.cid);
  }
});

/* ================= transcript search (words & phrases) ================= */

function updateSearchInfo() {
  const n = state.searchMatches.length;
  const el = $("#searchInfo");
  el.textContent = state.query ? (n ? `${state.searchIdx + 1}/${n}` : "0/0") : "";
}

function findMatches() {
  const v = currentVideo();
  state.query = $("#searchInput").value.trim().toLowerCase();
  state.searchMatches = [];
  state.searchIdx = 0;
  if (state.query && v && v.words.length) {
    const texts = v.words.map((w) => (w.text || "").toLowerCase());
    const qWords = state.query.split(/\s+/).filter(Boolean);
    if (qWords.length === 1) {
      // single word: highlight every word containing it
      texts.forEach((t, i) => { if (t.includes(qWords[0])) state.searchMatches.push(i); });
    } else {
      // phrase: contiguous run of words, each containing its query word
      let i = 0;
      const n = texts.length;
      while (i <= n - qWords.length) {
        let ok = true;
        for (let k = 0; k < qWords.length; k++) {
          if (!texts[i + k].includes(qWords[k])) { ok = false; break; }
        }
        if (ok) {
          for (let k = 0; k < qWords.length; k++) state.searchMatches.push(i + k);
          i += qWords.length;
        } else {
          i++;
        }
      }
    }
  }
  updateWordClasses();
  updateSearchInfo();
}

function scrollToMatch() {
  const i = state.searchMatches[state.searchIdx];
  if (i == null) return;
  const el = $(`#words .word[data-i="${i}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  updateWordClasses();
  updateSearchInfo();
}

function stepMatch(dir) {
  if (!state.searchMatches.length) return;
  state.searchIdx = (state.searchIdx + dir + state.searchMatches.length) % state.searchMatches.length;
  scrollToMatch();
}

$("#searchInput").addEventListener("input", findMatches);
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); if (state.searchMatches.length) stepMatch(1); }
});

/* ================= settings ================= */

function loadSettings() {
  const s = $("#autoCut");
  return api("/api/settings").then((st) => {
    $("#asmKey").value = st.assembly_key || "";
    $("#orKey").value = st.openrouter_key || "";
    $("#modelInput").value = st.model || "";
    $("#outputDir").value = st.output_dir || "";
    s.checked = !!st.llm_auto_cut;
  });
}

let _settingsSaveTimer = null;
function saveSettingsDebounced(silent = true) {
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          assembly_key: $("#asmKey").value.trim(),
          openrouter_key: $("#orKey").value.trim(),
          model: $("#modelInput").value.trim(),
          llm_auto_cut: $("#autoCut").checked,
          output_dir: $("#outputDir").value.trim(),
        }),
      });
      if (!silent) {
        $("#settingsFlash").textContent = "✓ saved";
        setTimeout(() => ($("#settingsFlash").textContent = ""), 2000);
      } else {
        $("#settingsFlash").textContent = "✓ auto-saved";
        setTimeout(() => { if ($("#settingsFlash").textContent === "✓ auto-saved") $("#settingsFlash").textContent = ""; }, 1500);
      }
      renderHw();
    } catch (err) { toast(err.message, true); }
  }, 600);
}

["#asmKey", "#orKey", "#modelInput", "#outputDir"].forEach((sel) => {
  $(sel).addEventListener("input", () => saveSettingsDebounced(true));
});
$("#autoCut").addEventListener("change", () => saveSettingsDebounced(true));

function renderHw() {
  api("/api/system").then((hw) => {
    $("#hwInfo").innerHTML = `
      <div class="hw-row"><span>FFmpeg</span><b class="${hw.ffmpeg ? "ok" : "bad"}">${hw.ffmpeg ? "✓ " + (hw.ffmpeg_version || "") : "missing"}</b></div>
      <div class="hw-row"><span>yt-dlp</span><b class="${hw.ytdlp ? "ok" : "bad"}">${hw.ytdlp ? "✓" : "missing"}</b></div>
      <div class="hw-row"><span>NVENC (NVIDIA)</span><b class="${hw.nvenc ? "ok" : "bad"}">${hw.nvenc ? "✓ available" : "✗"}</b></div>
      <div class="hw-row"><span>QSV (Intel)</span><b class="${hw.qsv ? "ok" : "bad"}">${hw.qsv ? "✓ available" : "✗"}</b></div>
      <div class="hw-row"><span>Active encoder</span><b style="color:var(--gold-2)">${hw.encoder.toUpperCase()}</b></div>`;
    const sb = $("#sysInfo");
    sb.innerHTML = `
      <span class="sys-badge ${hw.ytdlp ? "on" : "off"}">yt-dlp</span>
      <span class="sys-badge ${hw.ffmpeg ? "on" : "off"}">ffmpeg</span>
      <span class="sys-badge ${hw.nvenc ? "on" : "off"}">NVENC</span>
      <span class="sys-badge ${hw.qsv ? "on" : "off"}">QSV</span>
      <span class="sys-badge on">${hw.encoder.toUpperCase()}</span>`;
  }).catch(() => {});
}

$("#saveSettings").addEventListener("click", () => saveSettingsDebounced(false));

/* settings panel: collapse to a clean icon */
$("#collapseSettings").addEventListener("click", () => {
  document.body.classList.add("settings-collapsed");
  localStorage.setItem("vs.settingsCollapsed", "1");
});
$("#expandSettings").addEventListener("click", () => {
  document.body.classList.remove("settings-collapsed");
  localStorage.setItem("vs.settingsCollapsed", "0");
});

/* open the default output folder in the OS file manager */
$("#btnOpenFolder").addEventListener("click", async () => {
  try {
    const r = await api("/api/settings/open-folder", { method: "POST" });
    toast(`Opened folder: ${r.path}`);
  } catch (err) { toast(err.message, true); }
});

/* right panel: search videos by title */
$("#videoSearch").addEventListener("input", (e) => {
  state.videoQuery = e.target.value.trim().toLowerCase();
  $("#videoSearchClear").classList.toggle("hidden", !state.videoQuery);
  renderVideoList();
});
$("#videoSearchClear").addEventListener("click", () => {
  $("#videoSearch").value = "";
  state.videoQuery = "";
  $("#videoSearchClear").classList.add("hidden");
  $("#videoSearch").focus();
  renderVideoList();
});

/* ================= upload & refresh ================= */

$("#uploadBtn").addEventListener("click", doUpload);
$("#urlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doUpload();
});

async function doUpload() {
  const url = $("#urlInput").value.trim();
  if (!url) return toast("Paste a video URL first", true);
  try {
    $("#uploadBtn").disabled = true;
    await api("/api/videos", { method: "POST", body: JSON.stringify({ url }) });
    $("#urlInput").value = "";
    $("#uploadBtn").disabled = false;
    toast("Downloading + transcribing…");
    await refresh();
    startPolling();
  } catch (err) {
    $("#uploadBtn").disabled = false;
    toast(err.message, true);
  }
}

function _inputFocused() {
  // Don't clobber the DOM while the user is typing in a list input (rename, queue title).
  const a = document.activeElement;
  if (!a) return false;
  return a.matches(".rename-input, [data-act='qtitle'], #searchInput, #videoSearch, #chatInput");
}

async function refresh() {
  const wasCurrent = state.currentId;

  state.videos = await api("/api/videos");

  if (state.editClip && !findClip(state.editClip.id)) cancelClipEdit();

  if (wasCurrent) {
    const cur = state.videos.find((v) => v.id === wasCurrent);
    if (cur) {
      state.currentId = wasCurrent;
      const prevLen = (state.words || []).length;
      state.words = cur.words || state.words;
      $("#videoTitle").textContent = cur.title;
      $("#statusBadge").textContent = cur.status;
      $("#statusBadge").className = "badge " + (cur.status === "ready" ? "ready"
        : cur.status === "error" ? "error" : "processing");
      // Force a word DOM rebuild only if the word set actually changed (e.g. just
      // finished transcribing); otherwise keep the DOM and just refresh classes.
      if (cur.words && cur.words.length !== prevLen) state.wordsBuiltFor = null;
      renderWords();
      renderQueue();
    }
  }
  if (!wasCurrent && state.videos.length) {
    openVideo(state.videos[0].id);
  }
  // Skip the video list rebuild while the user is typing into one of its inputs,
  // so a background poll can't yank focus or reset the caret mid-edit.
  if (!_inputFocused()) renderVideoList();
}

function anyBusy() {
  return state.videos.some((v) =>
    ["queued", "downloading", "transcribing", "analyzing"].includes(v.status) ||
    v.llm_status === "analyzing") ||
    state.videos.some((v) => (v.clips || []).some((c) => c.status === "cutting"));
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try { await refresh(); } catch {}
    if (!anyBusy()) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 2000);
}

/* ================= chat agent (DeepSeek) ================= */

const chatEls = {
  panel: () => $("#chatPanel"),
  msgs: () => $("#chatMessages"),
  input: () => $("#chatInput"),
  send: () => $("#chatSend"),
  ctx: () => $("#chatContext"),
};

function chatOpen() { return document.body.classList.contains("chat-open"); }

function toggleChat(force) {
  const open = force == null ? !chatOpen() : force;
  document.body.classList.toggle("chat-open", open);
  $("#chatToggle").classList.toggle("active", open);
  state.chat.open = open;
  localStorage.setItem("vs.chatOpen", open ? "1" : "0");
  if (open) {
    // autosize + focus
    chatEls.input().focus();
    chatScrollToBottom();
  }
}

function updateChatContext() {
  const v = currentVideo();
  const el = chatEls.ctx();
  if (v) {
    el.textContent = `Context: ${v.title}`;
    el.classList.add("has-video");
  } else {
    el.textContent = "No video open";
    el.classList.remove("has-video");
  }
}

function chatScrollToBottom() {
  const m = chatEls.msgs();
  m.scrollTop = m.scrollHeight;
}

function autoGrowTextarea() {
  const ta = chatEls.input();
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}

function renderChatMessages() {
  const wrap = chatEls.msgs();
  const h = state.chat.history;
  if (!h.length && !state.chat.busy) {
    wrap.innerHTML = `<div class="chat-empty">
      <div class="chat-empty-icon">✦</div>
      <p>Ask the agent to find moments in the transcript — e.g. <i>“find the hook”</i> or <i>“where does he sing about the plane”</i>.</p>
      <p>Suggested timings come back as cards you can preview or cut.</p>
    </div>`;
    return;
  }
  let html = "";
  for (const m of h) {
    if (m.role === "user") {
      html += `<div class="chat-msg user"><div class="chat-bubble">${esc(m.content)}</div></div>`;
    } else if (m.role === "agent") {
      html += renderAgentMsg(m);
    }
  }
  if (state.chat.busy) html += `<div class="chat-thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  wrap.innerHTML = html;
  chatScrollToBottom();
}

function renderAgentMsg(m) {
  let html = `<div class="chat-msg agent"><div class="chat-bubble">${esc(m.content)}</div>`;
  if (m.timings && m.timings.length) {
    for (const t of m.timings) {
      const id = t._id || (t._id = "tc" + Math.random().toString(36).slice(2, 9));
      const dur = ((t.end_ms - t.start_ms) / 1000).toFixed(1);
      html += `<div class="timing-card" data-tcid="${id}">
        <div class="timing-card-head">
          <span class="timing-card-title">${esc(t.title)}</span>
          <span class="timing-card-time">${fmtMs(t.start_ms)} – ${fmtMs(t.end_ms)} · ${dur}s</span>
        </div>
        ${t.quote ? `<div class="timing-card-quote">“${esc(t.quote)}”</div>` : ""}
        ${t.why ? `<div class="timing-card-why">${esc(t.why)}</div>` : ""}
        <div class="timing-card-acts">
          <button class="btn tiny" data-act="tc-preview" data-tcid="${id}">▶ Preview</button>
          <button class="btn tiny gold" data-act="tc-add" data-tcid="${id}">＋ Add clip</button>
        </div>
      </div>`;
    }
  }
  html += `</div>`;
  return html;
}

function findTiming(tcid) {
  for (const m of state.chat.history) {
    if (m.role === "agent" && m.timings) {
      const t = m.timings.find((x) => x._id === tcid);
      if (t) return t;
    }
  }
  return null;
}

function previewTiming(t) {
  const v = currentVideo();
  if (!v) return toast("Open a video first", true);
  state.editClip = null;
  state.clipMode = null;
  setPlayerSrc("video", v.id);
  $("#clipModeBar").classList.add("hidden");
  const p = $("#player");
  p.currentTime = t.start_ms / 1000;
  _previewStopAt = t.end_ms / 1000;
  p.play().catch(() => {});
  toast(`Preview ${fmtMs(t.start_ms)} – ${fmtMs(t.end_ms)}`);
}

async function addTimingClip(t) {
  const v = currentVideo();
  if (!v) return toast("Open a video first", true);
  try {
    await api(`/api/videos/${v.id}/clips`, {
      method: "POST",
      body: JSON.stringify({ start_ms: t.start_ms, end_ms: t.end_ms, title: t.title }),
    });
    toast(`Cutting “${t.title}”…`);
    const card = document.querySelector(`.timing-card[data-tcid="${t._id}"]`);
    if (card) card.classList.add("added");
    await refresh();
    startPolling();
  } catch (err) { toast(err.message, true); }
}

async function sendChat() {
  const v = currentVideo();
  if (!v) return toast("Open a video first", true);
  if (v.status !== "ready") return toast("Wait until the video is transcribed", true);
  const ta = chatEls.input();
  const message = ta.value.trim();
  if (!message || state.chat.busy) return;
  state.chat.history.push({ role: "user", content: message });
  ta.value = "";
  autoGrowTextarea();
  state.chat.busy = true;
  chatEls.send().disabled = true;
  renderChatMessages();
  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        video_id: v.id,
        history: state.chat.history
          .filter((m) => m.role !== "agent" || m.content)
          .slice(-12)
          .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content })),
      }),
    });
    state.chat.history.push({
      role: "agent",
      content: res.reply || "(no reply)",
      timings: res.timings || [],
    });
    persistChat();
  } catch (err) {
    state.chat.history.push({ role: "agent", content: "⚠ " + err.message, timings: [] });
  } finally {
    state.chat.busy = false;
    chatEls.send().disabled = false;
    renderChatMessages();
    chatEls.input().focus();
  }
}

function persistChat() {
  try {
    localStorage.setItem("vs.chatHistory", JSON.stringify(state.chat.history.slice(-30)));
  } catch {}
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem("vs.chatHistory");
    if (raw) state.chat.history = JSON.parse(raw) || [];
  } catch {}
}

$("#chatToggle").addEventListener("click", () => toggleChat());
$("#chatClose").addEventListener("click", () => toggleChat(false));
$("#chatSend").addEventListener("click", sendChat);
chatEls.input().addEventListener("input", autoGrowTextarea);
chatEls.input().addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

/* chat timing card actions (delegated) */
chatEls.msgs().addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act='tc-preview'], [data-act='tc-add']");
  if (!btn) return;
  const tcid = btn.dataset.tcid;
  const t = findTiming(tcid);
  if (!t) return;
  if (btn.dataset.act === "tc-preview") previewTiming(t);
  else addTimingClip(t);
});

/* ================= boot ================= */

(async function boot() {
  if (localStorage.getItem("vs.settingsCollapsed") === "1") {
    document.body.classList.add("settings-collapsed");
  }
  if (localStorage.getItem("vs.chatOpen") === "1") toggleChat(true);
  loadChatHistory();
  initWordSelection();
  await loadSettings();
  renderHw();
  await refresh();
  renderChatMessages();
  updateChatContext();
  if (anyBusy()) startPolling();
})();
