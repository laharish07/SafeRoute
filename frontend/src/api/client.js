// api/client.js
//
// Thin wrapper over the Flask backend. In dev, Vite's proxy (vite.config.js)
// forwards /api/* to the backend, so this works with no base URL at all;
// in production, set VITE_API_BASE_URL to wherever the Flask app is
// deployed.

const BASE = import.meta.env.VITE_API_BASE_URL || "";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // some endpoints (e.g. 503 briefing-unavailable) still return JSON;
    // only truly empty bodies land here
  }
  if (!res.ok && !body) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return body;
}

const post = (path, data) =>
  request(path, { method: "POST", body: JSON.stringify(data) });
const get = (path) => request(path);

export const api = {
  // ── Routing ──
  getMultiRoute: (payload) => post("/route/multi", payload),
  getRoute: (payload) => post("/route", payload),
  getWeights: () => get("/weights"),
  getWeightsAll: () => get("/weights/all"),

  // ── Feedback ──
  submitFeedback: (payload) => post("/feedback", payload),

  // ── Community reports ──
  getReportsMeta: () => get("/reports/meta"),
  submitReport: (payload) => post("/report", payload),
  getReportsOnRoute: (coords) => post("/reports/route", { coords }),
  getReportsNearby: (lat, lon, radiusM = 500) =>
    get(`/reports/nearby?lat=${lat}&lon=${lon}&radius_m=${radiusM}`),

  // ── Live news feed ──
  getNewsStatus: () => get("/news/status"),
  getNewsRecent: (limit = 50) => get(`/news/recent?limit=${limit}`),
  getNewsOnRoute: (coords) => post("/news/route", { coords }),
  refreshNews: () => post("/news/refresh"),

  // ── Overlays ──
  getCrimeOnRoute: (coords) => post("/crime/route", { coords }),
  getDeadEndsOnRoute: (coords) => post("/deadends/route", { coords }),
  getRoadQualityOnRoute: (coords) => post("/roadquality/route", { coords }),

  // ── AI ──
  getAIModelStatus: () => get("/ai/model-status"),
  predictSatisfaction: (payload) => post("/ai/predict", payload),
  getRouteBriefing: (payload) => post("/ai/briefing", payload),

  // ── Cache (admin/demo visibility) ──
  getCacheStatus: () => get("/cache/status"),

  // ── Health ──
  getHealth: () => get("/health"),
};
