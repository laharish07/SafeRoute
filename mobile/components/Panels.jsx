// Sidebar panels from the static frontend: weights bar, route card, Customize Route, Route Insights.
import React, { useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Animated, StyleSheet } from "react-native";
import { colors, F, r, rLg, OPT, RQ } from "../theme";

const pct = (v) => Math.round((v || 0) * 100);

export function WeightsBar({ w }) {
  if (!w) return <Text style={s.wsrc}>Using default weights</Text>;
  const ws = pct(w.w_safety), wr = pct(w.w_road), wd = pct(w.w_deadend), wdst = Math.max(0, 100 - ws - wr - wd);
  const src = w.source === "learned"
    ? `Learned · ${w.based_on} ratings · ${Math.round((w.confidence || 0) * 100)}% confidence`
    : "Default weights";
  return (
    <>
      <View style={s.wbar}>
        <View style={{ flex: Math.max(ws, 0.001), backgroundColor: colors.green }} />
        <View style={{ flex: Math.max(wr, 0.001), backgroundColor: colors.blue }} />
        <View style={{ flex: Math.max(wd, 0.001), backgroundColor: colors.amber }} />
        <View style={{ flex: Math.max(wdst, 0.001), backgroundColor: colors.txtDim }} />
      </View>
      <Text style={s.wsrc}>{src}</Text>
    </>
  );
}

export function RecalcBar({ active }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (active) { v.setValue(0); Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: false }).start(); }
    else Animated.timing(v, { toValue: 0, duration: 300, useNativeDriver: false }).start();
  }, [active]);
  return (
    <View style={{ height: 2, marginBottom: 9, borderRadius: 2, overflow: "hidden" }}>
      <Animated.View style={{ height: 2, backgroundColor: colors.accent, width: v.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }} />
    </View>
  );
}

export function RouteCard({ label, loading, dist, eta, safety }) {
  const val = (v, unit) => (v == null ? "—" : v + unit);
  return (
    <View style={[s.rc, { borderLeftColor: label.color }]}>
      <View style={s.rcHead}>
        <Text style={{ fontSize: 17 }}>{label.icon}</Text>
        <Text style={s.rcTitle} numberOfLines={1}>{label.title}</Text>
        <View style={[s.badge, { backgroundColor: label.color }]}><Text style={s.badgeText}>ACTIVE</Text></View>
      </View>
      <View style={s.rcStats}>
        {[["Distance", val(dist, " km")], ["ETA", val(eta, " min")], ["Safety", val(safety, "%")]].map(([l, v]) => (
          <View key={l} style={{ flex: 1, alignItems: "center" }}>
            <Text style={s.rcLbl}>{l}</Text>
            {loading ? <View style={s.skel} /> : <Text style={s.rcVal}>{v}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}

const Panel = ({ title, children }) => (
  <View style={s.panel}>
    <Text style={s.ptitle}>{title}</Text>
    {children}
  </View>
);

const TOD = [["morning", "🌅 Morn"], ["afternoon", "☀ Aftn"], ["evening", "🌆 Eve"], ["night", "🌙 Night"]];

export function CustomizePanel({ active, onToggle, disabled, weights, todWeights, tod, setTod }) {
  const learned = weights?.source === "learned";
  const cons = weights?.consistency || {};
  const dot = (v) => ((v ?? 0.5) > 0.7 ? colors.green : (v ?? 0.5) > 0.4 ? colors.amber : colors.red);
  const rows = [["Safety", "w_safety", colors.green, "safety"], ["Road", "w_road", colors.blue, "road"], ["Dead-end", "w_deadend", colors.amber, "deadend"]];
  const tw = todWeights?.[tod] || {};
  const fmt = (v) => (v != null ? Math.round(v * 100) + "%" : "—");

  return (
    <Panel title="Customize Route">
      <View style={s.grid3}>
        {["safety", "road", "deadend"].map((k) => {
          const on = active.has(k);
          return (
            <TouchableOpacity key={k} disabled={disabled} onPress={() => onToggle(k)} activeOpacity={0.8}
              style={[s.gbtn, on && { backgroundColor: "#1a2035", borderColor: OPT[k].color }, disabled && { opacity: 0.6 }]}>
              <Text style={{ fontSize: 17 }}>{OPT[k].icon}</Text>
              <Text style={[s.glabel, on && { color: OPT[k].color }]}>{OPT[k].label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={s.tags}>
        {active.size === 0
          ? <Text style={[s.tag, { backgroundColor: colors.surface2, color: colors.txtMuted }]}>📏 Shortest path</Text>
          : [...active].map((k) => (
              <Text key={k} style={[s.tag, { color: OPT[k].color, backgroundColor: OPT[k].color + "1F" }]}>{OPT[k].icon} {OPT[k].label}</Text>
            ))}
      </View>

      {learned && (
        <View style={{ marginTop: 10 }}>
          {rows.map(([lbl, key, color, ck]) => (
            <View key={key} style={s.wrow}>
              <Text style={[s.wlbl, { color }]}>{lbl.toUpperCase()}</Text>
              <View style={s.track}><View style={{ height: 3, width: `${pct(weights[key])}%`, backgroundColor: color, borderRadius: 2 }} /></View>
              <Text style={s.wpct}>{pct(weights[key])}%</Text>
              <View style={[s.cdot, { backgroundColor: dot(cons[ck]) }]} />
            </View>
          ))}
        </View>
      )}

      {todWeights && Object.keys(todWeights).length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={[s.ptitle, { fontSize: 8, color: colors.txtDim, marginBottom: 6 }]}>Weights by time of day</Text>
          <View style={{ flexDirection: "row", gap: 3, marginBottom: 8 }}>
            {TOD.map(([k, l]) => (
              <TouchableOpacity key={k} style={[s.tod, tod === k && { backgroundColor: colors.accent, borderColor: colors.accent }]} onPress={() => setTod(k)}>
                <Text style={[s.todText, tod === k && { color: "#fff" }]}>{l.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {[["Safety", tw.w_safety, colors.green], ["Road", tw.w_road, colors.blue], ["Dead-end", tw.w_deadend, colors.amber]].map(([l, v, c]) => (
              <View key={l} style={s.todStat}>
                <Text style={s.todLbl}>{l.toUpperCase()}</Text>
                <Text style={[s.todVal, { color: c }]}>{fmt(v)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </Panel>
  );
}

const OVL = [
  ["crime", "🚨", "Crime Zones", colors.red, "#1e1a2e"],
  ["deadendovl", "⚠️", "Dead Ends", "#f97316", "#1e2235"],
  ["roadquality", "🛣", "Road Quality", colors.purple, "#1a1e35"],
  ["reportsovl", "📢", "Reports", colors.accentHi, "#1a1a35"],
  ["newsovl", "📰", "News", "#fca5a5", "#2a1418"],
];

export function InsightsPanel({ active, loading, errors, onToggle, errorMsg }) {
  return (
    <Panel title="Route Insights">
      <View style={s.grid3}>
        {OVL.map(([k, icon, label, color, bg]) => {
          const on = active.has(k);
          return (
            <TouchableOpacity key={k} onPress={() => onToggle(k)} activeOpacity={0.8}
              style={[s.gbtn, { width: "31.9%" }, on && { borderColor: color, backgroundColor: bg }, errors.has(k) && { borderColor: colors.red, opacity: 0.6 }]}>
              {loading.has(k) ? <ActivityIndicator size="small" color={color} /> : <Text style={{ fontSize: 17 }}>{icon}</Text>}
              <Text style={[s.glabel, on && { color }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {!!errorMsg && <Text style={s.err}>{errorMsg}</Text>}
      {active.has("roadquality") && (
        <View style={{ marginTop: 10 }}>
          <Text style={[s.ptitle, { fontSize: 8, marginBottom: 7 }]}>Road type quality</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 4 }}>
            {RQ.map((x) => (
              <View key={x.label} style={{ width: "50%", flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: x.color }} />
                <Text style={{ fontFamily: F.mono, fontSize: 9, color: colors.txtMuted }}>{x.label}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </Panel>
  );
}

const s = StyleSheet.create({
  wbar: { flexDirection: "row", height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 3 },
  wsrc: { fontFamily: F.mono, fontSize: 9, color: colors.txtDim, marginBottom: 10, minHeight: 12 },
  rc: { backgroundColor: colors.surface2, borderRadius: rLg, borderLeftWidth: 4, padding: 13, marginBottom: 10 },
  rcHead: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 },
  rcTitle: { flex: 1, fontFamily: F.head, fontSize: 13, color: colors.txt },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontFamily: F.monoMed, fontSize: 9, color: "#fff", letterSpacing: 0.4 },
  rcStats: { flexDirection: "row", gap: 4 },
  rcLbl: { fontFamily: F.mono, fontSize: 8, color: colors.txtMuted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 3 },
  rcVal: { fontFamily: F.monoMed, fontSize: 15, color: colors.txt },
  skel: { width: 52, height: 19, borderRadius: 4, backgroundColor: colors.border2, opacity: 0.7 },
  panel: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: rLg, padding: 13, marginBottom: 8 },
  ptitle: { fontFamily: F.monoMed, fontSize: 9, color: colors.txtMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 },
  grid3: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  gbtn: {
    width: "31.9%", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 9, paddingHorizontal: 5,
    backgroundColor: colors.surface2, borderWidth: 2, borderColor: "transparent", borderRadius: r, minHeight: 58,
  },
  glabel: { fontFamily: F.monoMed, fontSize: 8, color: colors.txtMuted, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.4 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 9, minHeight: 22 },
  tag: { fontFamily: F.monoMed, fontSize: 9, paddingHorizontal: 9, paddingVertical: 2, borderRadius: 20, overflow: "hidden" },
  wrow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 5 },
  wlbl: { fontFamily: F.mono, fontSize: 8, width: 52, letterSpacing: 0.4 },
  track: { flex: 1, height: 3, backgroundColor: colors.border, borderRadius: 2, overflow: "hidden" },
  wpct: { fontFamily: F.mono, fontSize: 8, color: colors.txtMuted, width: 28, textAlign: "right" },
  cdot: { width: 6, height: 6, borderRadius: 3 },
  tod: { flex: 1, paddingVertical: 5, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 5, alignItems: "center" },
  todText: { fontFamily: F.mono, fontSize: 8, color: colors.txtMuted, letterSpacing: 0.3 },
  todStat: { flex: 1, alignItems: "center", paddingVertical: 6, backgroundColor: colors.surface2, borderRadius: 6 },
  todLbl: { fontFamily: F.mono, fontSize: 8, color: colors.txtMuted, letterSpacing: 0.4, marginBottom: 3 },
  todVal: { fontFamily: F.monoMed, fontSize: 12 },
  err: { fontFamily: F.mono, fontSize: 9, color: colors.red, textAlign: "center", marginTop: 7 },
});
