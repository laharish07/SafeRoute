// Flask API client. EXPO_PUBLIC_API_URL already includes /api.
const BASE = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:5001/api").replace(/\/$/, "");

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  } catch (e) {
    throw new Error(`Network error: ${e.message}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}
const post = (p, d) => request(p, { method: "POST", body: JSON.stringify(d) });

export const api = {
  getRoute: (payload) => post("/route", payload),
  getWeights: (timeOfDay, options) => {
    const qs = new URLSearchParams({ time_of_day: timeOfDay, ...(options ? { options } : {}) });
    return request(`/weights?${qs}`);
  },
  getWeightsAll: (options) => request(`/weights/all${options ? `?options=${encodeURIComponent(options)}` : ""}`),
  submitFeedback: (p) => post("/feedback", p),
  submitReport: (p) => post("/report", p),
  getOverlay: (key, coords) => {
    const ep = { crime: "/crime/route", deadendovl: "/deadends/route", roadquality: "/roadquality/route", reportsovl: "/reports/route", newsovl: "/news/route" }[key];
    return post(ep, { coords });
  },
  getNewsStatus: () => request("/news/status"),
};
