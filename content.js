const GQL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

let lastVideoId = null;
let graphData = null;
let resizeObserver = null;
let playerObserver = null;

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

  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(GQL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }).then((r) => r.json());
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {};
}

async function fetchSegment(videoId, start, end, workerId, progressTracker) {
  const stamps = [];
  const seen = new Set();
  let offset = start;
  let empty = 0;
  const LIMIT = 100;

  while (offset < end) {
    if (videoId !== getCurrentVideoId()) return null;

    try {
      const res = await gql({
        operationName: "VideoComments",
        query: `query VideoComments($id:ID!,$off:Int,$lim:Int){
          video(id:$id){
            comments(contentOffsetSeconds:$off,first:$lim){
              edges{node{contentOffsetSeconds id}}
            }
          }
        }`,
        variables: { id: videoId, off: Math.floor(offset), lim: LIMIT },
      });

      const edges = res.data?.video?.comments?.edges || [];

      if (!edges.length) {
        empty++;
        offset += Math.min(empty > 5 ? 60 : 10, end - offset);
        progressTracker[workerId] = offset - start;
        continue;
      }

      empty = 0;

      const minT = edges[0].node.contentOffsetSeconds;
      const maxT = edges[edges.length - 1].node.contentOffsetSeconds;

      for (const { node } of edges) {
        if (
          node.contentOffsetSeconds >= start &&
          node.contentOffsetSeconds < end &&
          !seen.has(node.id)
        ) {
          seen.add(node.id);
          stamps.push(node.contentOffsetSeconds);
        }
      }

      let next = maxT;
      if (edges.length >= LIMIT && minT === maxT) next = maxT + 1;
      if (next <= offset) next = offset + 1;

      offset = next;
      progressTracker[workerId] = Math.min(offset, end) - start;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return stamps;
}

async function fetchChat(id, onProgress) {
  const d = await gql({
    query: `query V($id:ID!){video(id:$id){lengthSeconds}}`,
    variables: { id },
  });

  const dur = d.data?.video?.lengthSeconds;
  if (!dur) return null;

  const CONCURRENCY = 6;
  const segmentSize = Math.ceil(dur / CONCURRENCY);
  const progressTracker = new Array(CONCURRENCY).fill(0);

  const report = () =>
    onProgress(
      progressTracker.reduce((a, b) => a + b, 0),
      dur
    );

  const interval = setInterval(report, 500);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetchSegment(
        id,
        i * segmentSize,
        Math.min((i + 1) * segmentSize, dur),
        i,
        progressTracker
      )
    )
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
  if (!container.firstChild) {
    const cvs = document.createElement("canvas");
    cvs.id = "vodpulse-canvas";
    container.appendChild(cvs);
  }

  const cvs = container.firstChild;
  const rect = container.getBoundingClientRect();
  cvs.width = rect.width;
  cvs.height = rect.height;

  const ctx = cvs.getContext("2d");
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  const bins = new Uint32Array(Math.ceil(cvs.width / 2));
  const secPerBin = dur / bins.length;

  for (const t of stamps) {
    const i = Math.floor(t / secPerBin);
    if (i < bins.length) bins[i]++;
  }

  const max = Math.max(...bins, 1);
  ctx.fillStyle = "rgba(169,112,255,0.9)";

  for (let i = 0; i < bins.length; i++) {
    if (!bins[i]) continue;
    const h = Math.pow(bins[i] / max, 2) * cvs.height;
    ctx.fillRect(i * 2, cvs.height - h, 2, Math.max(h, 1));
  }
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

function updateGraphVisibility() {
  const player = document.querySelector(".video-player__container");
  const graph = document.getElementById("vodpulse-graph-container");
  if (!player || !graph) return;

  graph.style.opacity = player.classList.contains("video-player--idle")
    ? "0"
    : "1";
}

function clearUI() {
  graphData = null;
  document.getElementById("vodpulse-graph-container")?.remove();
  document.getElementById("vodpulse-btn-inject")?.remove();
}

function init() {
  const videoId = getCurrentVideoId();
  if (videoId !== lastVideoId) {
    lastVideoId = videoId;
    clearUI();
  }
  if (!videoId) return;

  const controls = findControlsGroup();
  const overlay = document.querySelector(".video-player__overlay");
  const player = document.querySelector(".video-player__container");
  if (!controls || !overlay || !player) return;

  if (!playerObserver) {
    playerObserver = new MutationObserver(updateGraphVisibility);
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  if (!document.getElementById("vodpulse-btn-inject")) {
    const btn = document.createElement("button");
    btn.id = "vodpulse-btn-inject";
    btn.className = "vodpulse-btn";
    btn.textContent = "VodPulse";

    btn.onclick = async () => {
      btn.disabled = true;
      const res = await fetchChat(videoId, (c, t) => {
        btn.textContent = `${Math.round((c / t) * 100)}%`;
      });
      btn.textContent = res ? "Done" : "VodPulse";
      btn.disabled = false;
      if (res) drawGraph(res.stamps, res.dur);
    };

    controls.appendChild(btn);
  }

  if (!document.getElementById("vodpulse-graph-container")) {
    const div = document.createElement("div");
    div.id = "vodpulse-graph-container";
    overlay.appendChild(div);
  }

  updateGraphVisibility();
}

setInterval(init, 500);
