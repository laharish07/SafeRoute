// Design tokens — ported from backend/static/css/style.css (the original SafeRoute UI).
export const colors = {
  bg: "#0d1117", surface: "#161b27", surface2: "#1d2436", border: "#252e44", border2: "#2e3a55",
  txt: "#e2e8f0", txtMuted: "#64748b", txtDim: "#3d4e68",
  accent: "#6366f1", accentHi: "#818cf8",
  green: "#22c55e", blue: "#3b82f6", amber: "#f59e0b", red: "#ef4444", purple: "#a78bfa",
};

// Font family names (loaded in App.jsx via @expo-google-fonts)
export const F = {
  head: "Syne_700Bold", headXL: "Syne_800ExtraBold",
  ui: "DMSans_400Regular", uiMed: "DMSans_500Medium", uiSemi: "DMSans_600SemiBold",
  mono: "DMMono_400Regular", monoMed: "DMMono_500Medium",
};

export const r = 8, rLg = 12;

export const OPT = {
  safety: { color: "#22c55e", icon: "🛡", label: "Safety" },
  road: { color: "#3b82f6", icon: "🛣", label: "Better Roads" },
  deadend: { color: "#f59e0b", icon: "🚫", label: "No Dead Ends" },
};

export const RQ = [
  { keys: ["motorway", "trunk"], color: "#22c55e", label: "Motorway / Trunk" },
  { keys: ["primary"], color: "#84cc16", label: "Primary" },
  { keys: ["secondary", "tertiary"], color: "#eab308", label: "Secondary / Tertiary" },
  { keys: ["residential", "living_street"], color: "#f97316", label: "Residential" },
  { keys: ["service", "unclassified", "road", "track", "construction"], color: "#ef4444", label: "Service / Other" },
];
export const RQ_COLOR_MAP = {};
RQ.forEach((x) => x.keys.forEach((k) => { RQ_COLOR_MAP[k] = x.color; }));

export const ISSUE_TYPES = [
  { key: "pothole", icon: "🕳", label: "Pothole" },
  { key: "lighting", icon: "💡", label: "Broken/No Light" },
  { key: "road_condition", icon: "🛣", label: "Poor Road" },
  { key: "dead_end", icon: "🚧", label: "Dead End" },
  { key: "obstruction", icon: "⛔", label: "Obstruction" },
  { key: "crime", icon: "🚨", label: "Unsafe / Crime" },
  { key: "flooding", icon: "🌊", label: "Flooding" },
  { key: "other", icon: "❓", label: "Other" },
];
export const SEVERITIES = ["low", "medium", "high"];
export const SEV_COLOR = { low: "#22c55e", medium: "#f59e0b", high: "#ef4444" };
export const NEWS_SEV_COLOR = { low: "#f59e0b", medium: "#f97316", high: "#ef4444" };

export const FALLBACK_PRESETS = {
  "": { w_safety: 0, w_road: 0, w_deadend: 0, w_distance: 1 },
  shortest: { w_safety: 0, w_road: 0, w_deadend: 0, w_distance: 1 },
  safety: { w_safety: 0.9, w_road: 0, w_deadend: 0, w_distance: 0.1 },
  road: { w_safety: 0, w_road: 0.9, w_deadend: 0, w_distance: 0.1 },
  deadend: { w_safety: 0, w_road: 0.05, w_deadend: 0.9, w_distance: 0.05 },
  "road+safety": { w_safety: 0.5, w_road: 0.4, w_deadend: 0, w_distance: 0.1 },
  "deadend+safety": { w_safety: 0.5, w_road: 0, w_deadend: 0.4, w_distance: 0.1 },
  "deadend+road": { w_safety: 0, w_road: 0.45, w_deadend: 0.45, w_distance: 0.1 },
  "deadend+road+safety": { w_safety: 0.3, w_road: 0.3, w_deadend: 0.3, w_distance: 0.1 },
};
