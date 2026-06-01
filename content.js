const GQL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

let lastVideoId = null;
let graphData = null;
let resizeObserver = null;
let tooltipEl = null;
let isFetching = false;

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

async function gql(payload) {
  const headers = {
    "Client-Id": AUTH.id,
    "Content-Type": "application/json",
  };
  if (AUTH.token) headers["Authorization"] = AUTH.token;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(GQL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return await resp.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return Array.isArray(payload) ? payload.map(() => ({})) : {};
}

function buildCommentsQuery(videoId, offset) {
  return {
    operationName: "VideoComments",
    query: `query VideoComments($id:ID!,$off:Int,$lim:Int){
      video(id:$id){
        comments(contentOffsetSeconds:$off,first:$lim){
          edges{node{contentOffsetSeconds id}}
        }
      }
    }`,
    variables: { id: videoId, off: Math.floor(offset), lim: PAGE_LIMIT },
  };
}

const PAGE_LIMIT = 100;

async function fetchSegment(videoId, start, end, workerId, progressTracker) {
  const stamps = [];
  const seen = new Set();
  let offset = start;
  let emptyStreak = 0;

  while (offset < end) {
    if (videoId !== getCurrentVideoId()) return null;

    try {
      const res = await gql(buildCommentsQuery(videoId, offset));
      const edges = res?.data?.video?.comments?.edges || [];

      if (!edges.length) {
        emptyStreak++;
        const skip = Math.min(
          10 * Math.pow(3, Math.min(emptyStreak - 1, 4)),
          end - offset,
        );
        offset += Math.max(skip, 1);
        if (typeof workerId === "number") {
          progressTracker[workerId] = Math.min(offset, end) - start;
        }
        continue;
      }

      emptyStreak = 0;
      const maxT = processEdges(edges, start, end, seen, stamps);
      let next = maxT;
      if (edges.length >= PAGE_LIMIT) {
        const minT = edges[0].node.contentOffsetSeconds;
        if (minT === maxT) next = maxT + 1;
      }
      if (next <= offset) next = offset + 1;
      offset = next;
      if (typeof workerId === "number") {
        progressTracker[workerId] = Math.min(offset, end) - start;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return stamps;
}

function processEdges(edges, start, end, seen, stamps) {
  let maxT = -Infinity;
  for (const { node } of edges) {
    const t = node.contentOffsetSeconds;
    if (t >= start && t < end && !seen.has(node.id)) {
      seen.add(node.id);
      stamps.push(t);
    }
    if (t > maxT) maxT = t;
  }
  return maxT;
}

async function fetchChat(id, onProgress) {
  const d = await gql({
    query: `query V($id:ID!){video(id:$id){lengthSeconds}}`,
    variables: { id },
  });

  const dur = d.data?.video?.lengthSeconds;
  if (!dur) return null;

  const CONCURRENCY = 20;
  const segmentSize = Math.ceil(dur / CONCURRENCY);
  const progressTracker = new Array(CONCURRENCY).fill(0);

  const report = () =>
    onProgress(
      progressTracker.reduce((a, b) => a + b, 0),
      dur,
    );

  const interval = setInterval(report, 400);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetchSegment(
        id,
        i * segmentSize,
        Math.min((i + 1) * segmentSize, dur),
        i,
        progressTracker,
      ),
    ),
  );

  clearInterval(interval);

  if (results.some((r) => r === null)) return null;

  return {
    stamps: results.flat().sort((a, b) => a - b),
    dur,
  };
}

function drawGraph(stamps, dur) {
  graphData = { stamps, dur };

  const container = document.getElementById("vodpulse-graph-container");
  if (!container) return;

  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      if (graphData) renderCanvas(container, graphData.stamps, graphData.dur);
    });
    resizeObserver.observe(container);
  }

  renderCanvas(container, stamps, dur);
}

function renderCanvas(container, stamps, dur) {
  if (!container.querySelector("canvas")) {
    const cvs = document.createElement("canvas");
    cvs.id = "vodpulse-canvas";
    container.appendChild(cvs);
  }

  const cvs = container.querySelector("canvas");
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cvs.width = rect.width * dpr;
  cvs.height = rect.height * dpr;
  cvs.style.width = rect.width + "px";
  cvs.style.height = rect.height + "px";

  const ctx = cvs.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const W = rect.width;
  const H = rect.height;

  const numBins = Math.max(Math.ceil(W / 3), 10);
  const bins = new Uint32Array(numBins);
  const secPerBin = dur / numBins;

  for (const t of stamps) {
    const i = Math.min(Math.floor(t / secPerBin), numBins - 1);
    bins[i]++;
  }

  let max = 1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] > max) max = bins[i];
  }

  const points = [];
  for (let i = 0; i < numBins; i++) {
    const x = (i / (numBins - 1)) * W;
    const normalized = bins[i] / max;
    const y = H - Math.pow(normalized, 1.3) * (H - 2);
    points.push({ x, y });
  }

  const smoothed = [];
  for (let i = 0; i < points.length; i++) {
    const windowSize = 2;
    let sumY = 0;
    let count = 0;
    for (
      let j = Math.max(0, i - windowSize);
      j <= Math.min(points.length - 1, i + windowSize);
      j++
    ) {
      sumY += points[j].y;
      count++;
    }
    smoothed.push({ x: points[i].x, y: sumY / count });
  }

  ctx.save();
  ctx.filter = "blur(6px)";
  ctx.strokeStyle = "rgba(169, 112, 255, 0.5)";
  ctx.lineWidth = 4;
  drawSmoothLine(ctx, smoothed);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  drawSmoothLine(ctx, smoothed);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "rgba(169, 112, 255, 0.6)");
  gradient.addColorStop(0.5, "rgba(145, 71, 255, 0.25)");
  gradient.addColorStop(1, "rgba(145, 71, 255, 0.02)");
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  drawSmoothLine(ctx, smoothed);
  ctx.strokeStyle = "rgba(190, 150, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  container._vodpulseBins = bins;
  container._vodpulseMax = max;
  container._vodpulseNumBins = numBins;
  container._vodpulseDur = dur;
}

function drawSmoothLine(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  for (let i = 0; i < pts.length - 1; i++) {
    const cp1x = (pts[i].x + pts[i + 1].x) / 2;
    const cp1y = pts[i].y;
    const cp2x = cp1x;
    const cp2y = pts[i + 1].y;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pts[i + 1].x, pts[i + 1].y);
  }
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "vodpulse-tooltip";
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
  const container = document.getElementById("vodpulse-graph-container");
  if (!container || !container._vodpulseBins) return;

  const rect = container.getBoundingClientRect();
  const seekbar =
    document.querySelector(".seekbar-bar") ||
    document.querySelector('[data-a-target="player-seekbar"]') ||
    document.querySelector(".seekbar-interaction-area");

  let minY = rect.top;
  let maxY = rect.bottom;
  if (seekbar) {
    const seekRect = seekbar.getBoundingClientRect();
    minY = Math.min(rect.top, seekRect.top);
    maxY = Math.max(rect.bottom, seekRect.bottom);
  }

  if (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < minY ||
    e.clientY > maxY
  ) {
    hideTooltip();
    return;
  }

  const x = e.clientX - rect.left;
  const bins = container._vodpulseBins;
  const numBins = container._vodpulseNumBins;
  const dur = container._vodpulseDur;

  const binIndex = Math.min(
    Math.floor((x / rect.width) * numBins),
    numBins - 1,
  );
  const count = bins[binIndex] || 0;
  const timeStart = (binIndex / numBins) * dur;
  const timeEnd = ((binIndex + 1) / numBins) * dur;

  const tip = ensureTooltip();
  const safeCount = String(count).replace(/[&<>/'"]/g, "");
  const safeStart = formatTime(timeStart).replace(/[&<>/'"]/g, "");
  const safeEnd = formatTime(timeEnd).replace(/[&<>/'"]/g, "");
  tip.innerHTML = `
    <span class="vodpulse-tooltip-time">${safeStart} – ${safeEnd}</span>
    <span class="vodpulse-tooltip-sep">·</span>
    <span class="vodpulse-tooltip-count">${safeCount} messages</span>
  `;
  tip.style.opacity = "1";

  // Fixed vertical position just above seekbar, below hover preview card
  tip.style.top = rect.bottom - 24 + "px";
  tip.style.left = e.clientX + "px";
  tip.style.transform = "translateX(-50%)";
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

function syncGraphPosition() {
  const graph = document.getElementById("vodpulse-graph-container");
  if (!graph) return;

  const seekbar =
    document.querySelector(".seekbar-bar") ||
    document.querySelector('[data-a-target="player-seekbar"]') ||
    document.querySelector(".seekbar-interaction-area");

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
  document.getElementById("vodpulse-graph-container")?.remove();
  document.getElementById("vodpulse-btn-inject")?.remove();
  hideTooltip();
}

const PULSE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 3 9 21 6 12 2 12"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>`;

function init() {
  const videoId = getCurrentVideoId();
  if (videoId !== lastVideoId) {
    lastVideoId = videoId;
    isFetching = false;
    clearUI();
  }
  if (!videoId) return;

  const controls = findControlsGroup();
  const overlay = document.querySelector(".video-player__overlay");
  const player = document.querySelector(".video-player__container");
  if (!controls || !overlay || !player) return;

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

        drawGraph(res.stamps, res.dur);

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

  if (!document.getElementById("vodpulse-graph-container")) {
    const div = document.createElement("div");
    div.id = "vodpulse-graph-container";
    overlay.appendChild(div);

    overlay.addEventListener("mousemove", handleGraphMouseMove);
    overlay.addEventListener("mouseleave", hideTooltip);
  }

  syncGraphPosition();
}

setInterval(init, 500);
