const GQL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

// `first` is capped server-side: Twitch ignores it and returns a fixed page of
// ~54-59 edges. 100 is simply the largest accepted value.
const PAGE_LIMIT = 100;
// A page this size that sits entirely in one second means the cap was hit
// inside that second.
const SATURATED_PAGE = 50;
const CONCURRENCY = 60;
// Worker queries packed into one HTTP request. Measured on the live endpoint
// (60 queries/round, median of 3): 1 -> 775ms, 5 -> 331ms, 10 -> 407ms,
// 30 -> 620ms — the server handles a large batch serially.
const GQL_BATCH = 5;
// Remaining seconds below which a segment is not worth splitting off.
const MIN_SPLIT = 30;

let lastVideoId = null;
let graphData = null;
let layoutObserver = null;
let tooltipEl = null;
let tooltipTime = null;
let tooltipCount = null;
let isFetching = false;

let binCounts = null;
let binTotal = 0;
let binDur = 0;
let canvasCtx = null;

const getCookie = (name) => {
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? match[2] : null;
};

const AUTH = (() => {
  const cookieToken = getCookie("auth-token");
  const cookieClientId = getCookie("client-id");
  return {
    id: cookieClientId || DEFAULT_CLIENT_ID,
    token: cookieToken ? `OAuth ${cookieToken}` : null,
  };
})();

// A shared backoff: a rate limit pauses every worker, not just the one that
// hit it.
let throttledUntil = 0;
let throttleStep = 0;

function throttle(ms) {
  throttledUntil = Math.max(throttledUntil, Date.now() + ms);
}

async function awaitThrottle() {
  const wait = throttledUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function gql(payload) {
  const headers = {
    "Client-Id": AUTH.id,
    "Content-Type": "application/json",
  };
  if (AUTH.token) headers["Authorization"] = AUTH.token;

  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 3; attempt++) {
    await awaitThrottle();
    try {
      const resp = await fetch(GQL, { method: "POST", headers, body });
      if (!resp.ok) {
        const retryAfter = Number(resp.headers.get("Retry-After"));
        throttleStep = Math.min(throttleStep + 1, 6);
        throttle(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 250 * Math.pow(2, throttleStep),
        );
        continue;
      }
      throttleStep = Math.max(0, throttleStep - 1);
      return await resp.json();
    } catch {
      throttleStep = Math.min(throttleStep + 1, 6);
      throttle(300 * Math.pow(2, throttleStep));
    }
  }
  return Array.isArray(payload) ? payload.map(() => null) : null;
}

// The endpoint accepts an array of operations in one POST; fall back to one
// request per query if it ever stops doing so.
let batchSupported = true;

async function gqlMulti(queries) {
  if (batchSupported) {
    const res = await gql(queries);
    if (Array.isArray(res) && res.length === queries.length) return res;
    batchSupported = false;
  }
  return Promise.all(queries.map((q) => gql(q)));
}

// Twitch gates `after:` behind its integrity challenge, which a content script
// cannot answer, so this is tried once and then disabled for the session.
let cursorPagingAvailable = true;

function buildCursorQuery(videoId, offset, after) {
  return {
    operationName: "VideoCommentsCursor",
    query:
      "query VideoCommentsCursor($id:ID!,$off:Int,$after:Cursor,$lim:Int){video(id:$id){comments(contentOffsetSeconds:$off,after:$after,first:$lim){pageInfo{hasNextPage}edges{cursor node{contentOffsetSeconds id}}}}}",
    variables: {
      id: videoId,
      off: after ? null : Math.floor(offset),
      after: after || null,
      lim: PAGE_LIMIT,
    },
  };
}

function buildCommentsQuery(videoId, offset) {
  return {
    operationName: "VideoComments",
    query:
      "query VideoComments($id:ID!,$off:Int,$lim:Int){video(id:$id){comments(contentOffsetSeconds:$off,first:$lim){pageInfo{hasNextPage}edges{node{contentOffsetSeconds id}}}}}",
    variables: { id: videoId, off: Math.floor(offset), lim: PAGE_LIMIT },
  };
}

function advanceWorker(w, res, counts) {
  const comments = res?.data?.video?.comments;

  if (!comments) {
    // Skip ahead eventually, so a broken window cannot stall the run.
    if (++w.failures >= 5) {
      w.failures = 0;
      w.offset = Math.min(w.offset + 10, w.end);
    }
    if (w.offset >= w.end) w.done = true;
    w.progress = Math.min(w.offset, w.end) - w.start;
    return -1;
  }

  w.failures = 0;
  const edges = comments.edges || [];
  let saturated = -1;

  if (!edges.length) {
    w.emptyStreak++;
    const skip = Math.min(
      10 * Math.pow(3, Math.min(w.emptyStreak - 1, 4)),
      w.end - w.offset,
    );
    w.offset += Math.max(skip, 1);
  } else {
    w.emptyStreak = 0;

    // Offsets only move forward, so a message can be returned twice only by
    // two adjacent pages — a one-page Set is enough to dedupe.
    const prev = w.prevIds;
    const cur = new Set();
    let maxT = -Infinity;
    const minT = edges[0].node.contentOffsetSeconds;

    for (let i = 0; i < edges.length; i++) {
      const node = edges[i].node;
      const id = node.id;
      const t = node.contentOffsetSeconds;
      cur.add(id);
      if (t >= w.start && t < w.end && !prev.has(id)) {
        const s = Math.floor(t);
        if (s >= 0 && s < counts.length) counts[s]++;
      }
      if (t > maxT) maxT = t;
    }
    w.prevIds = cur;

    // A whole page inside one second means offset paging has hit its floor:
    // the rest of that second is only reachable via a cursor.
    let next = maxT;
    if (minT === maxT) {
      next = maxT + 1;
      if (maxT >= w.start && maxT < w.end && edges.length >= SATURATED_PAGE) {
        saturated = maxT;
      }
    }
    if (next <= w.offset) next = w.offset + 1;
    w.offset = next;
  }

  if (w.offset >= w.end) w.done = true;
  w.progress = Math.min(w.offset, w.end) - w.start;
  return saturated;
}

// Walks the cursor chain for one saturated second.
// Returns "ok" (second fully counted), "unresolved" (transient failure, the
// cursor path stays enabled) or "blocked" (Twitch refused the `after:`
// argument, so the path is disabled for the rest of the session).
async function drainSaturatedSecond(id, second, knownIds, counts) {
  let res = await gql(buildCursorQuery(id, second, null));
  let comments = res?.data?.video?.comments;
  // Carries no cursor, so its failure says nothing about cursor paging.
  if (!comments) return "unresolved";

  const seen = new Set(knownIds);
  let guard = 0;

  for (;;) {
    const edges = comments.edges || [];
    if (!edges.length) return "ok";

    let sameSecond = true;
    for (let i = 0; i < edges.length; i++) {
      const node = edges[i].node;
      if (node.contentOffsetSeconds !== second) {
        sameSecond = false;
        continue;
      }
      if (!seen.has(node.id)) {
        seen.add(node.id);
        counts[second]++;
      }
    }
    if (!sameSecond || !comments.pageInfo?.hasNextPage) return "ok";
    if (++guard > 40) return "ok";

    res = await gql(
      buildCursorQuery(id, second, edges[edges.length - 1].cursor),
    );
    comments = res?.data?.video?.comments;
    if (!comments) return "blocked";
  }
}

async function fetchChat(id, onProgress) {
  const d = await gql({
    query: "query V($id:ID!){video(id:$id){lengthSeconds}}",
    variables: { id },
  });

  const dur = d?.data?.video?.lengthSeconds;
  if (!dur) return null;

  const counts = new Int32Array(dur);
  let truncatedSeconds = 0;

  const workerCount = Math.max(1, Math.min(CONCURRENCY, Math.ceil(dur / 60)));
  const segmentSize = Math.ceil(dur / workerCount);

  const makeWorker = (start, end) => ({
    start,
    end,
    offset: start,
    emptyStreak: 0,
    failures: 0,
    prevIds: new Set(),
    progress: 0,
    done: false,
    busy: false,
  });

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    const start = i * segmentSize;
    const end = Math.min((i + 1) * segmentSize, dur);
    if (start >= end) continue;
    workers.push(makeWorker(start, end));
  }

  // Hands a lane up to GQL_BATCH idle workers. When there are too few, the
  // longest remaining segments are split in half: chat density is uneven, so
  // equal segments would otherwise leave most of the pool idle while a few
  // workers grind through the busy stretches.
  const claim = () => {
    const batch = [];
    let active = 0;
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (w.done) continue;
      active++;
      if (!w.busy && batch.length < GQL_BATCH) batch.push(w);
    }

    while (batch.length < GQL_BATCH && active < CONCURRENCY) {
      let big = null;
      for (let i = 0; i < workers.length; i++) {
        const w = workers[i];
        if (!w.done && (!big || w.end - w.offset > big.end - big.offset)) {
          big = w;
        }
      }
      if (!big || big.end - big.offset < MIN_SPLIT) break;

      // Safe even while `big` is in flight: it only counts messages before
      // its own `end`, and anything past it now belongs to the new worker.
      const mid = Math.ceil((big.offset + big.end) / 2);
      const w = makeWorker(mid, big.end);
      big.end = mid;
      workers.push(w);
      batch.push(w);
      active++;
    }

    for (let i = 0; i < batch.length; i++) batch[i].busy = true;
    return batch;
  };

  // Cursor top-ups run one at a time beside the lanes instead of stalling
  // them.
  const drainQueue = [];
  let draining = null;

  const runDrains = async () => {
    while (
      drainQueue.length &&
      cursorPagingAvailable &&
      id === getCurrentVideoId()
    ) {
      const { second, ids } = drainQueue.shift();
      const outcome = await drainSaturatedSecond(id, second, ids, counts);
      if (outcome === "ok") truncatedSeconds--;
      else if (outcome === "blocked") cursorPagingAvailable = false;
    }
    drainQueue.length = 0;
  };

  const queueDrain = (second, ids) => {
    truncatedSeconds++;
    if (!cursorPagingAvailable) return;
    drainQueue.push({ second, ids });
    if (!draining) {
      draining = runDrains().finally(() => {
        draining = null;
      });
    }
  };

  // Each lane keeps one request in flight and moves on as soon as it returns,
  // so a slow or retried request holds up only its own batch.
  const lane = async () => {
    for (;;) {
      if (id !== getCurrentVideoId()) return;
      const batch = claim();
      if (!batch.length) return;

      const res = await gqlMulti(
        batch.map((w) => buildCommentsQuery(id, w.offset)),
      );
      for (let i = 0; i < batch.length; i++) {
        const w = batch[i];
        w.busy = false;
        const second = advanceWorker(w, res[i], counts);
        if (second >= 0) queueDrain(second, w.prevIds);
      }
    }
  };

  const report = () => {
    let total = 0;
    for (let i = 0; i < workers.length; i++) total += workers[i].progress;
    onProgress(total, dur);
  };
  const interval = setInterval(report, 400);

  try {
    const lanes = [];
    const laneCount = Math.ceil(CONCURRENCY / GQL_BATCH);
    for (let i = 0; i < laneCount; i++) lanes.push(lane());
    await Promise.all(lanes);
    while (draining) await draining;
  } finally {
    clearInterval(interval);
  }

  if (id !== getCurrentVideoId()) return null;

  report();
  if (truncatedSeconds > 0) {
    console.warn(
      `VodPulse: ${truncatedSeconds} second(s) exceeded Twitch's page cap and are undercounted ` +
        `(cursor paging ${cursorPagingAvailable ? "did not resolve them" : "is blocked by Twitch's integrity check"}).`,
    );
  }
  return { counts, dur };
}

let renderPending = false;

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    const container = document.getElementById("vodpulse-graph-container");
    if (container && graphData) {
      renderCanvas(container, graphData.counts, graphData.dur);
    }
  });
}

function drawGraph(counts, dur) {
  graphData = { counts, dur };
  const container = document.getElementById("vodpulse-graph-container");
  if (!container) return;
  renderCanvas(container, counts, dur);
}

function renderCanvas(container, counts, dur) {
  const rect = container.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  if (W < 1 || H < 1) return;

  let cvs = container.querySelector("canvas");
  if (!cvs) {
    cvs = document.createElement("canvas");
    cvs.id = "vodpulse-canvas";
    container.appendChild(cvs);
    canvasCtx = null;
  }
  if (!canvasCtx || canvasCtx.canvas !== cvs) canvasCtx = cvs.getContext("2d");

  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(W * dpr);
  const pxH = Math.round(H * dpr);
  if (cvs.width !== pxW || cvs.height !== pxH) {
    cvs.width = pxW;
    cvs.height = pxH;
    cvs.style.width = W + "px";
    cvs.style.height = H + "px";
  }

  const ctx = canvasCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const numBins = Math.max(Math.ceil(W / 3), 10);
  const bins = new Float64Array(numBins);
  const secPerBin = dur / numBins;

  for (let s = 0; s < dur; s++) {
    const c = counts[s];
    if (!c) continue;
    let i = (s / secPerBin) | 0;
    if (i >= numBins) i = numBins - 1;
    bins[i] += c;
  }

  // Box blur of raw counts via prefix sums.
  const WINDOW = 2;
  const prefix = new Float64Array(numBins + 1);
  for (let i = 0; i < numBins; i++) prefix[i + 1] = prefix[i] + bins[i];
  const smooth = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const lo = i - WINDOW > 0 ? i - WINDOW : 0;
    const hi = i + WINDOW < numBins - 1 ? i + WINDOW : numBins - 1;
    smooth[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }

  // Subtract background, scale by a high percentile so quiet chats show spikes too.
  const sorted = Float64Array.from(smooth).sort();
  const pct = (p) =>
    sorted[Math.min(numBins - 1, Math.floor(p * (numBins - 1)))];
  const base = pct(0.3);
  const max = sorted[numBins - 1];
  let ref = pct(0.97) - base;
  if (!(ref > 0)) ref = max - base;
  if (!(ref > 0)) ref = 1;

  // Linear up to KNEE, outliers compress softly into the rest.
  const KNEE = 0.85;
  const smoothY = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const v = Math.max(0, smooth[i] - base) / ref;
    const n =
      v <= 1 ? v * KNEE : KNEE + (1 - KNEE) * (1 - Math.exp(-(v - 1) * 1.5));
    smoothY[i] = H - n * (H - 2);
  }

  // Build the path once and reuse it for all three passes.
  const line = buildSmoothPath(smoothY, numBins, W);
  const area = new Path2D(line);
  area.lineTo(W, H);
  area.lineTo(0, H);
  area.closePath();

  ctx.save();
  ctx.filter = "blur(6px)";
  ctx.strokeStyle = "rgba(169, 112, 255, 0.5)";
  ctx.lineWidth = 4;
  ctx.stroke(line);
  ctx.restore();

  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "rgba(169, 112, 255, 0.6)");
  gradient.addColorStop(0.5, "rgba(145, 71, 255, 0.25)");
  gradient.addColorStop(1, "rgba(145, 71, 255, 0.02)");
  ctx.fillStyle = gradient;
  ctx.fill(area);

  ctx.strokeStyle = "rgba(190, 150, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke(line);

  binCounts = bins;
  binTotal = numBins;
  binDur = dur;
}

function buildSmoothPath(ys, n, W) {
  const path = new Path2D();
  if (n < 2) return path;
  const step = W / (n - 1);
  path.moveTo(0, ys[0]);
  for (let i = 0; i < n - 1; i++) {
    const x0 = i * step;
    const x1 = x0 + step;
    const cpx = (x0 + x1) / 2;
    path.bezierCurveTo(cpx, ys[i], cpx, ys[i + 1], x1, ys[i + 1]);
  }
  return path;
}

let rectsDirty = true;
let cachedGraphRect = null;
let cachedMinY = 0;
let cachedMaxY = 0;
let pendingMouseX = 0;
let pendingMouseY = 0;
let tooltipRaf = 0;

function invalidateRects() {
  rectsDirty = true;
}

function findSeekbar() {
  return (
    document.querySelector(".seekbar-bar") ||
    document.querySelector('[data-a-target="player-seekbar"]') ||
    document.querySelector(".seekbar-interaction-area")
  );
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "vodpulse-tooltip";

  tooltipTime = document.createElement("span");
  tooltipTime.className = "vodpulse-tooltip-time";

  const sep = document.createElement("span");
  sep.className = "vodpulse-tooltip-sep";
  sep.textContent = "·";

  tooltipCount = document.createElement("span");
  tooltipCount.className = "vodpulse-tooltip-count";

  tooltipEl.append(tooltipTime, sep, tooltipCount);
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function handleGraphMouseMove(e) {
  if (!binCounts) return;
  pendingMouseX = e.clientX;
  pendingMouseY = e.clientY;
  if (!tooltipRaf) tooltipRaf = requestAnimationFrame(flushTooltip);
}

function flushTooltip() {
  tooltipRaf = 0;
  if (!binCounts) return;

  const container = document.getElementById("vodpulse-graph-container");
  if (!container) return;

  if (rectsDirty || !cachedGraphRect) {
    cachedGraphRect = container.getBoundingClientRect();
    const seekbar = findSeekbar();
    if (seekbar) {
      const seekRect = seekbar.getBoundingClientRect();
      cachedMinY = Math.min(cachedGraphRect.top, seekRect.top);
      cachedMaxY = Math.max(cachedGraphRect.bottom, seekRect.bottom);
    } else {
      cachedMinY = cachedGraphRect.top;
      cachedMaxY = cachedGraphRect.bottom;
    }
    rectsDirty = false;
  }

  const rect = cachedGraphRect;
  if (
    pendingMouseX < rect.left ||
    pendingMouseX > rect.right ||
    pendingMouseY < cachedMinY ||
    pendingMouseY > cachedMaxY
  ) {
    hideTooltip();
    return;
  }

  const x = pendingMouseX - rect.left;
  let binIndex = Math.floor((x / rect.width) * binTotal);
  if (binIndex < 0) binIndex = 0;
  if (binIndex >= binTotal) binIndex = binTotal - 1;

  const count = binCounts[binIndex] || 0;
  const timeStart = (binIndex / binTotal) * binDur;
  const timeEnd = ((binIndex + 1) / binTotal) * binDur;

  const tip = ensureTooltip();
  tooltipTime.textContent = `${formatTime(timeStart)} – ${formatTime(timeEnd)}`;
  tooltipCount.textContent = `${count} messages`;
  tip.style.opacity = "1";

  // Fixed vertical position just above seekbar, below hover preview card.
  // Moved with a transform so following the cursor skips layout.
  tip.style.transform = `translate(${pendingMouseX}px, ${rect.bottom - 24}px) translateX(-50%)`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.opacity = "0";
}

function getCurrentVideoId() {
  return location.pathname.match(/videos\/(\d+)/)?.[1] || null;
}

function findControlsGroup() {
  return (
    document.querySelector('[data-a-target="player-controls-left"]') ||
    document
      .querySelector('[data-a-target="player-play-pause-button"]')
      ?.closest(".player-controls__left-control-group")
  );
}

let syncPending = false;

function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => {
    syncPending = false;
    syncGraphPosition();
  });
}

function syncGraphPosition() {
  invalidateRects();

  const graph = document.getElementById("vodpulse-graph-container");
  if (!graph) return;

  const seekbar = findSeekbar();
  if (!seekbar) return;

  const overlay = graph.parentElement;
  if (!overlay) return;

  const seekRect = seekbar.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();

  graph.style.left = seekRect.left - overlayRect.left + "px";
  graph.style.right = overlayRect.right - seekRect.right + "px";
}

function clearUI() {
  graphData = null;
  binCounts = null;
  canvasCtx = null;
  if (layoutObserver) {
    layoutObserver.disconnect();
    layoutObserver = null;
  }
  document.getElementById("vodpulse-graph-container")?.remove();
  document.getElementById("vodpulse-btn-inject")?.remove();
  hideTooltip();
}

const PULSE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 3 9 21 6 12 2 12"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>`;

function inject(videoId) {
  const controls = findControlsGroup();
  const overlay = document.querySelector(".video-player__overlay");
  const player = document.querySelector(".video-player__container");
  if (!controls || !overlay || !player) return false;

  // Pure CSS handles video-player idle/hover visibility of the graph container automatically

  if (!document.getElementById("vodpulse-btn-inject")) {
    const btn = document.createElement("button");
    btn.id = "vodpulse-btn-inject";
    btn.className = "vodpulse-btn";
    btn.innerHTML = `<span class="vodpulse-btn-icon">${PULSE_ICON}</span><span class="vodpulse-btn-text">VodPulse</span><span class="vodpulse-btn-progress"></span>`;

    btn.onclick = async () => {
      if (isFetching) return;
      isFetching = true;

      btn.disabled = true;
      btn.classList.add("vodpulse-btn--loading");

      const textEl = btn.querySelector(".vodpulse-btn-text");
      const progressEl = btn.querySelector(".vodpulse-btn-progress");
      const iconEl = btn.querySelector(".vodpulse-btn-icon");

      const res = await fetchChat(videoId, (c, t) => {
        const pct = Math.round((c / t) * 100);
        textEl.textContent = `${pct}%`;
        progressEl.style.width = `${pct}%`;
      });

      btn.classList.remove("vodpulse-btn--loading");

      if (res) {
        btn.classList.add("vodpulse-btn--done");
        iconEl.innerHTML = CHECK_ICON;
        textEl.textContent = "Done";
        progressEl.style.width = "100%";

        drawGraph(res.counts, res.dur);

        setTimeout(() => {
          btn.classList.remove("vodpulse-btn--done");
          iconEl.innerHTML = PULSE_ICON;
          textEl.textContent = "VodPulse";
          progressEl.style.width = "0%";
          btn.disabled = false;
          isFetching = false;
        }, 3000);
      } else {
        textEl.textContent = "VodPulse";
        progressEl.style.width = "0%";
        btn.disabled = false;
        isFetching = false;
      }
    };

    controls.appendChild(btn);
  }

  let container = document.getElementById("vodpulse-graph-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "vodpulse-graph-container";
    overlay.appendChild(container);

    overlay.addEventListener("mousemove", handleGraphMouseMove, {
      passive: true,
    });
    overlay.addEventListener("mouseenter", invalidateRects, { passive: true });
    overlay.addEventListener("mouseleave", hideTooltip, { passive: true });
  }

  if (layoutObserver) layoutObserver.disconnect();
  layoutObserver = new ResizeObserver(() => {
    invalidateRects();
    scheduleSync();
    scheduleRender();
  });
  layoutObserver.observe(container);
  layoutObserver.observe(overlay);
  const seekbar = findSeekbar();
  if (seekbar) layoutObserver.observe(seekbar);

  syncGraphPosition();
  return true;
}

// A pathname regex on every run; DOM work only until the UI is mounted.
function tick() {
  const videoId = getCurrentVideoId();

  if (videoId !== lastVideoId) {
    lastVideoId = videoId;
    isFetching = false;
    clearUI();
  }
  if (!videoId) return;

  const btn = document.getElementById("vodpulse-btn-inject");
  const graph = document.getElementById("vodpulse-graph-container");
  if (btn?.isConnected && graph?.isConnected) return;

  inject(videoId);
}

window.addEventListener("resize", invalidateRects, { passive: true });
window.addEventListener("scroll", invalidateRects, {
  passive: true,
  capture: true,
});

setInterval(tick, 500);
