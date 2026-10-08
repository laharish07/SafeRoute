// HomeScreen — port of backend/static/js/app.js (the original SafeRoute UI) to React Native.
// Sidebar → draggable bottom sheet. Leaflet map → OsmMap (OSM tiles).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Dimensions, useWindowDimensions, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";

import OsmMap from "../components/OsmMap";
import BottomSheet from "../components/BottomSheet";
import LocationField from "../components/LocationField";
import { WeightsBar, RecalcBar, RouteCard, CustomizePanel, InsightsPanel } from "../components/Panels";
import { FeedbackModal, ReportModal } from "../components/Modals";
import { api } from "../api/client";
import { reverseGeocode } from "../api/geocode";
import { routeProps, routeToCoords } from "../geo";
import { colors, F, r, rLg, OPT, FALLBACK_PRESETS } from "../theme";

const SCREEN_H = Dimensions.get("screen").height;

const timeOfDayLabel = (h) => (h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night");
const optionsKey = (opts) => [...opts].sort().join("+") || "shortest";

function buildLabel(opts) {
  const o = [...opts];
  if (!o.length) return { icon: "📏", title: "Shortest Route", color: "#6366f1" };
  if (o.length === 1) return { icon: OPT[o[0]].icon, title: OPT[o[0]].label + " Route", color: OPT[o[0]].color };
  return { icon: o.map((k) => OPT[k].icon).join(" "), title: o.map((k) => OPT[k].label).join(" + "), color: "#a78bfa" };
}

// Blend learned weights with the user's chosen emphasis (same maths as the web app)
function computeWeights(opts, learned) {
  const key = optionsKey(opts);
  if (key === "shortest") return { w_safety: 0, w_road: 0, w_deadend: 0, w_distance: 1, mode: "shortest" };
  const emphasis = { safety: [1, 0, 0], road: [0, 1, 0], deadend: [0, 0.1, 1] };
  let es = 0, er = 0, ed = 0;
  for (const o of opts) { const e = emphasis[o]; es += e[0]; er += e[1]; ed += e[2]; }
  const et = es + er + ed || 1; es /= et; er /= et; ed /= et;
  if (learned && learned.source === "learned") {
    const b = 0.7;
    let ws = b * learned.w_safety + (1 - b) * es, wr = b * learned.w_road + (1 - b) * er, wd = b * learned.w_deadend + (1 - b) * ed;
    const tot = ws + wr + wd || 1; ws /= tot; wr /= tot; wd /= tot;
    return { w_safety: +(ws * 0.9).toFixed(3), w_road: +(wr * 0.9).toFixed(3), w_deadend: +(wd * 0.9).toFixed(3), w_distance: 0.1, mode: key };
  }
  return { ...(FALLBACK_PRESETS[key] || FALLBACK_PRESETS[""]), mode: key };
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();

  const [src, setSrc] = useState(null);
  const [dst, setDst] = useState(null);
  const [clickMode, setClickMode] = useState(null);       // 'src' | 'dst' | null
  const [reportMode, setReportMode] = useState(false);
  const [reportLoc, setReportLoc] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);

  const [route, setRoute] = useState(null);
  const [options, setOptions] = useState(new Set());
  const [fetching, setFetching] = useState(false);
  const fetchingRef = useRef(false);
  const [finding, setFinding] = useState(false);

  const [learned, setLearned] = useState(null);
  const [todWeights, setTodWeights] = useState(null);
  const [tod, setTod] = useState(timeOfDayLabel(new Date().getHours()));

  const [overlays, setOverlays] = useState(new Set());
  const [overlayData, setOverlayData] = useState({});
  const [ovlLoading, setOvlLoading] = useState(new Set());
  const [ovlErrors, setOvlErrors] = useState(new Set());
  const [ovlMsg, setOvlMsg] = useState("");

  const [status, setStatus] = useState({ msg: "", cls: "" });
  const [newsStatus, setNewsStatus] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const [snap, setSnap] = useState(1);
  const [headerH, setHeaderH] = useState(60);
  const [me, setMe] = useState(null);

  const heights = useMemo(
    () => [headerH + 16 + insets.bottom, Math.round(SCREEN_H * 0.5), Math.round(SCREEN_H * 0.88)],
    [headerH, insets.bottom]
  );

  // ── init: learned weights + news badge (refreshed every 5 min) ──
  const fetchLearned = useCallback(async (opts = new Set()) => {
    const o = [...opts].sort().join(",");
    try {
      const w = await api.getWeights(timeOfDayLabel(new Date().getHours()), o);
      setLearned(w); return w;
    } catch { setLearned(null); return null; }
  }, []);
  const fetchTod = useCallback(async (opts = new Set()) => {
    const o = [...opts].sort().join(",");
    try {
      const all = await api.getWeightsAll(o);
      setTodWeights(all); setTod(timeOfDayLabel(new Date().getHours()));
    } catch { setTodWeights(null); }
  }, []);
  useEffect(() => {
    fetchLearned();
    const load = () => api.getNewsStatus().then(setNewsStatus).catch(() => setNewsStatus({ unavailable: true }));
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchLearned]);

  // ── pins ──
  function placePin(field, lat, lon, label) {
    const pin = { lat, lon, label };
    field === "src" ? setSrc(pin) : setDst(pin);
  }
  const handleMapPress = useCallback(async (c) => {
    const { latitude: lat, longitude: lon } = c;
    if (reportMode) { setReportLoc({ lat, lon }); setReportMode(false); return; }
    if (!clickMode) return;
    const field = clickMode;
    placePin(field, lat, lon, `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    if (field === "src" && !dst) setClickMode("dst");
    else { setClickMode(null); }
    const label = await reverseGeocode(lat, lon);
    placePin(field, lat, lon, label);                  // upgrade coordinate → human label
    if (field !== "src" || dst) setStatus({ msg: "Ready — tap Find Route", cls: "ok" });
  }, [clickMode, reportMode, dst]);

  function setPickMode(mode) {
    setReportMode(false);
    const next = clickMode === mode ? null : mode;
    setClickMode(next);
    setStatus({ msg: next ? (next === "src" ? "Tap map to set source" : "Tap map to set destination") : "", cls: "" });
    if (next) setSnap(0);                              // get the sheet out of the way
  }
  function toggleReport() {
    const on = !reportMode;
    setReportMode(on);
    if (on) { setClickMode(null); setSnap(0); }
  }

  async function useMyLocation() {
    const { status: st } = await Location.requestForegroundPermissionsAsync();
    if (st !== "granted") return Alert.alert("Permission denied", "Location access is needed to use your position.");
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setMe({ lat: loc.coords.latitude, lon: loc.coords.longitude });
      placePin("src", loc.coords.latitude, loc.coords.longitude, "My location");
    } catch (e) { Alert.alert("Couldn't get location", e.message); }
  }

  // ── overlays ──
  const loadOverlay = useCallback(async (key, rt) => {
    const coords = routeToCoords(rt);
    if (!coords.length) return;
    setOvlLoading((s) => new Set(s).add(key));
    setOvlErrors((s) => { const n = new Set(s); n.delete(key); return n; });
    setOvlMsg("");
    try {
      const data = await api.getOverlay(key, coords);
      setOverlayData((p) => ({ ...p, [key]: { crime: data.points, deadendovl: data.points, roadquality: data.segments, reportsovl: data.reports, newsovl: data.articles }[key] || [] }));
    } catch (e) {
      setOvlErrors((s) => new Set(s).add(key));
      setOvlMsg(`${key} overlay failed to load`);
    } finally {
      setOvlLoading((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

  async function toggleOverlay(key) {
    const next = new Set(overlays);
    if (next.has(key)) {
      next.delete(key); setOverlays(next); setOvlMsg("");
      setOverlayData((p) => ({ ...p, [key]: [] }));
    } else {
      next.add(key); setOverlays(next);
      await loadOverlay(key, route);
    }
  }

  // ── routing ──
  async function fetchRoute(opts, learnedW, { reloadOverlays = true } = {}) {
    if (!src || !dst || fetchingRef.current) return false;
    fetchingRef.current = true; setFetching(true);
    const w = computeWeights(opts, learnedW);
    try {
      const data = await api.getRoute({
        source: { lat: src.lat, lon: src.lon }, destination: { lat: dst.lat, lon: dst.lon },
        hour: new Date().getHours(), ...w,
      });
      if (!data?.features?.[0]) throw new Error("No route found");
      setRoute(data);
      if (reloadOverlays) for (const k of overlays) await loadOverlay(k, data);   // keep active overlays in sync
      return true;
    } catch (e) {
      setStatus({ msg: "Route failed: " + e.message, cls: "error" });
      return false;
    } finally { fetchingRef.current = false; setFetching(false); }
  }

  async function findRoutes() {
    if (!src || !dst || finding) return;
    const none = new Set();
    setOptions(none);
    setOverlays(new Set()); setOverlayData({}); setOvlErrors(new Set()); setOvlMsg("");
    setFinding(true); setStatus({ msg: "Finding route…", cls: "" });
    setRoute(null);
    const [w] = await Promise.all([fetchLearned(none), fetchTod(none)]);
    const ok = await fetchRoute(none, w, { reloadOverlays: false });
    setFinding(false);
    if (ok) { setStatus({ msg: "Route found", cls: "ok" }); setSnap(1); }
  }

  async function toggleOption(k) {
    if (fetchingRef.current) return;
    const next = new Set(options);
    next.has(k) ? next.delete(k) : next.add(k);
    setOptions(next);
    const w = await fetchLearned(next);
    fetchTod(next);
    await fetchRoute(next, w);
  }

  function resetAll() {
    setSrc(null); setDst(null); setClickMode(null); setReportMode(false);
    setOptions(new Set()); setOverlays(new Set()); setOverlayData({}); setOvlErrors(new Set()); setOvlMsg("");
    setRoute(null); setLearned(null); setTodWeights(null); setStatus({ msg: "", cls: "" });
    setResetKey((k) => k + 1); fetchLearned();
  }

  // ── derived ──
  const label = buildLabel(options);
  const props = routeProps(route);
  const dist = props.distance_km ?? null;
  const eta = dist !== null ? Math.round((dist / 20) * 60) : null;
  const hasRoute = !!route;
  const hint = reportMode ? "Tap the map to place your report" : null;
  const statusColor = status.cls === "error" ? colors.red : status.cls === "ok" ? colors.green : colors.txtMuted;

  const header = (
    <View onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)} style={s.header}>
      <View style={s.logo}>
        <Text style={{ fontSize: 22 }}>🛡</Text>
        <Text style={s.logoText}>SafeRoute</Text>
        <View style={s.logoBadge}><Text style={s.logoBadgeText}>Bangalore</Text></View>
      </View>
      {hasRoute && (
        <View style={s.peek}>
          <Text style={{ fontSize: 14 }}>{label.icon}</Text>
          <Text style={s.peekTitle} numberOfLines={1}>{label.title}</Text>
          <Text style={s.peekStat}>{dist} km</Text>
          <Text style={s.peekStat}>{eta} min</Text>
          <Text style={[s.peekStat, { color: label.color }]}>{props.safety_pct}%</Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={s.root}>
      <OsmMap
        src={src} dst={dst} me={me} onMapPress={handleMapPress} route={route} routeColor={label.color}
        overlays={overlays} overlayData={overlayData}
        padTop={insets.top + 70} padBottom={heights[1] + 10}
      />

      {/* Report FAB (top-right on mobile; bottom-right in the web app) */}
      <View style={[s.fabWrap, { top: insets.top + 10 }]} pointerEvents="box-none">
        <TouchableOpacity style={[s.fab, reportMode && { backgroundColor: colors.red }]} onPress={toggleReport} activeOpacity={0.85}>
          <Text style={{ fontSize: 14 }}>{reportMode ? "✕" : "📢"}</Text>
          <Text style={s.fabText}>{reportMode ? "Tap map…" : "Report Issue"}</Text>
        </TouchableOpacity>
        {hint && <View style={s.hint}><Text style={s.hintText}>{hint}</Text></View>}
        {clickMode && !hint && <View style={s.hint}><Text style={s.hintText}>{clickMode === "src" ? "Tap map to set source" : "Tap map to set destination"}</Text></View>}
      </View>

      <BottomSheet heights={heights} snap={snap} onSnap={setSnap} header={header} maxHeight={win.height - insets.top - 8}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
          <WeightsBar w={learned} />

          <LocationField
            key={`src${resetKey}`} field="src" label="Source" pinIcon="📍" value={src} confirmed={!!src}
            pickActive={clickMode === "src"} onPick={() => setPickMode("src")} onFocus={() => setSnap(2)}
            onPlace={(p) => placePin("src", p.lat, p.lon, p.label)} onClear={() => setSrc(null)}
            extra={
              <TouchableOpacity onPress={useMyLocation} style={{ alignSelf: "flex-start", marginTop: 4 }}>
                <Text style={{ fontFamily: F.mono, fontSize: 9, color: colors.accentHi }}>⌖ USE MY LOCATION</Text>
              </TouchableOpacity>
            }
          />
          <LocationField
            key={`dst${resetKey}`} field="dst" label="Destination" pinIcon="🏁" value={dst} confirmed={!!dst}
            pickActive={clickMode === "dst"} onPick={() => setPickMode("dst")} onFocus={() => setSnap(2)}
            onPlace={(p) => placePin("dst", p.lat, p.lon, p.label)} onClear={() => setDst(null)}
          />

          <TouchableOpacity style={[s.primary, (!src || !dst || finding) && { opacity: 0.45 }]} disabled={!src || !dst || finding} onPress={findRoutes}>
            {finding && <ActivityIndicator size="small" color="#fff" />}
            <Text style={s.primaryText}>{finding ? "Routing…" : "Find Route"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.ghost} onPress={resetAll}><Text style={s.ghostText}>Clear map</Text></TouchableOpacity>
          <Text style={[s.status, { color: statusColor }]}>{status.msg}</Text>

          {hasRoute || finding ? (
            <View style={{ marginTop: 6 }}>
              <RecalcBar active={fetching} />
              <RouteCard label={label} loading={fetching && !hasRoute} dist={dist} eta={eta} safety={props.safety_pct ?? null} />
              <CustomizePanel
                active={options} onToggle={toggleOption} disabled={fetching || !hasRoute}
                weights={learned} todWeights={todWeights} tod={tod} setTod={setTod}
              />
              <InsightsPanel active={overlays} loading={ovlLoading} errors={ovlErrors} onToggle={toggleOverlay} errorMsg={ovlMsg} />
              <View style={s.hr} />
              <TouchableOpacity style={s.ghost} onPress={() => setShowFeedback(true)}><Text style={s.ghostText}>Rate this route ★</Text></TouchableOpacity>
            </View>
          ) : (
            <View style={s.empty}>
              <Text style={{ fontSize: 32, opacity: 0.5, marginBottom: 8 }}>🗺</Text>
              <Text style={s.emptyText}>Search a place above or tap the map{"\n"}to set source &amp; destination.</Text>
              <Text style={s.emptyHint}>📍 = source   |   🏁 = destination</Text>
            </View>
          )}

          <View style={s.footer}>
            <Text style={s.footerText}>Map data © OpenStreetMap · Geocoding via Nominatim{"\n"}Routing via pgRouting · Weights via user feedback</Text>
            <NewsBadge s={newsStatus} />
          </View>
        </ScrollView>
      </BottomSheet>

      {reportLoc && (
        <ReportModal
          location={reportLoc} onClose={() => setReportLoc(null)}
          onDone={(msg) => { setReportLoc(null); setStatus({ msg, cls: "ok" }); if (overlays.has("reportsovl") && route) loadOverlay("reportsovl", route); }}
        />
      )}
      <FeedbackModal
        visible={showFeedback && hasRoute} onClose={() => setShowFeedback(false)}
        onDone={async () => { setShowFeedback(false); setStatus({ msg: "Thank you! ✓", cls: "ok" }); await Promise.all([fetchLearned(options), fetchTod(options)]); }}
        src={src} dst={dst} props={props} optionsKey={optionsKey(options)}
        optionsLabel={options.size ? [...options].map((k) => OPT[k].label).join(" + ") + " route" : "shortest route"}
        timeOfDay={timeOfDayLabel(new Date().getHours())}
      />
    </View>
  );
}

function NewsBadge({ s: st }) {
  let text = "📰 Live crime feed: —", color = colors.txtDim;
  if (st?.unavailable) text = "📰 Live crime feed: unavailable";
  else if (st) {
    if (!st.auto_refresh_enabled) text = "📰 Live crime feed: disabled (no NEWS_API_KEY)";
    else if (!st.last_fetched_at) { text = "📰 Live crime feed: enabled, first fetch pending…"; color = colors.amber; }
    else {
      const mins = Math.round((Date.now() - new Date(st.last_fetched_at).getTime()) / 60000);
      const ago = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
      text = `📰 Live crime feed: updated ${ago} · ${st.total_articles} articles`;
      color = mins < 240 ? "#86efac" : colors.amber;
    }
  }
  return <Text style={{ fontFamily: F.mono, fontSize: 9, color, marginTop: 6 }}>{text}</Text>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 15, paddingBottom: 8 },
  logo: { flexDirection: "row", alignItems: "center", gap: 9, height: 34 },
  logoText: { fontFamily: F.headXL, fontSize: 17, color: colors.txt, letterSpacing: -0.3 },
  logoBadge: { marginLeft: "auto", backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 2 },
  logoBadgeText: { fontFamily: F.monoMed, fontSize: 9, color: "#fff", letterSpacing: 0.4 },
  peek: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border },
  peekTitle: { flex: 1, fontFamily: F.head, fontSize: 12, color: colors.txt },
  peekStat: { fontFamily: F.monoMed, fontSize: 12, color: colors.txt },
  fabWrap: { position: "absolute", right: 12, alignItems: "flex-end", gap: 8 },
  fab: {
    flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.accent, borderRadius: 24,
    paddingVertical: 10, paddingLeft: 14, paddingRight: 16, elevation: 8, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  fabText: { fontFamily: F.uiSemi, fontSize: 13, color: "#fff" },
  hint: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border2, borderRadius: r, paddingHorizontal: 11, paddingVertical: 7, elevation: 6 },
  hintText: { fontFamily: F.mono, fontSize: 10, color: colors.txt },
  primary: { flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent, borderRadius: r, paddingVertical: 11, marginTop: 6 },
  primaryText: { fontFamily: F.head, fontSize: 13, color: "#fff", letterSpacing: 0.2 },
  ghost: { alignItems: "center", paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: r, marginTop: 5 },
  ghostText: { fontFamily: F.ui, fontSize: 11, color: colors.txtMuted },
  status: { fontFamily: F.mono, fontSize: 10, textAlign: "center", marginTop: 7, minHeight: 15 },
  hr: { borderTopWidth: 1, borderTopColor: colors.border, marginVertical: 9 },
  empty: { alignItems: "center", paddingTop: 22 },
  emptyText: { fontFamily: F.ui, fontSize: 12, color: colors.txtMuted, textAlign: "center", lineHeight: 19 },
  emptyHint: { fontFamily: F.mono, fontSize: 9, color: colors.txtDim, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginTop: 8, overflow: "hidden" },
  footer: { marginTop: 18, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontFamily: F.mono, fontSize: 9, color: colors.txtDim, lineHeight: 15 },
});
