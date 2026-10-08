// Feedback + Report modals — centred cards, styled like the static frontend's .modal.
import React, { useRef, useState } from "react";
import { Modal, View, Text, TextInput, TouchableOpacity, Pressable, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { colors, F, r, rLg, OPT, ISSUE_TYPES, SEVERITIES, SEV_COLOR } from "../theme";
import { api } from "../api/client";

function Card({ visible, onClose, title, subtitle, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={m.fill}>
        <Pressable style={m.backdrop} onPress={onClose} />
        <View style={m.card}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={m.h3}>{title}</Text>
            <Text style={m.sub}>{subtitle}</Text>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const Section = ({ label, children }) => (<View style={{ marginBottom: 14 }}><Text style={m.lbl}>{label}</Text>{children}</View>);
const Actions = ({ onCancel, onSubmit, busy, submitLabel = "Submit" }) => (
  <View style={m.actions}>
    <TouchableOpacity style={[m.btn, { backgroundColor: colors.surface2 }]} onPress={onCancel}><Text style={[m.btnText, { color: colors.txtMuted }]}>Cancel</Text></TouchableOpacity>
    <TouchableOpacity style={[m.btn, { backgroundColor: colors.green }, busy && { opacity: 0.6 }]} onPress={onSubmit} disabled={busy}>
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={m.btnText}>{submitLabel}</Text>}
    </TouchableOpacity>
  </View>
);

function Stars({ value, onChange }) {
  return (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <TouchableOpacity key={i} onPress={() => onChange(i)} hitSlop={4}>
          <Text style={{ fontSize: 26, color: i <= value ? colors.amber : colors.txtDim }}>{i <= value ? "★" : "☆"}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const DUR = [["faster_than_expected", "Faster than expected"], ["as_expected", "As expected"], ["slower_than_expected", "Slower than expected"]];

export function FeedbackModal({ visible, onClose, onDone, src, dst, props, optionsKey, optionsLabel, timeOfDay }) {
  const [rt, setRt] = useState({ safety_rating: 3, road_rating: 3, deadend_rating: 3, overall_rating: 3 });
  const [again, setAgain] = useState(null);
  const [dur, setDur] = useState(null);
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const t0 = useRef(Date.now());
  React.useEffect(() => { if (visible) { setRt({ safety_rating: 3, road_rating: 3, deadend_rating: 3, overall_rating: 3 }); setAgain(null); setDur(null); setComments(""); t0.current = Date.now(); } }, [visible]);

  async function submit() {
    setBusy(true);
    try {
      await api.submitFeedback({
        src_lat: src.lat, src_lon: src.lon, dst_lat: dst.lat, dst_lon: dst.lon,
        route_options: optionsKey, route_length: props.distance_km ?? null, trip_duration: props.eta_min ?? null,
        time_of_day: timeOfDay, ...rt, would_use_again: again, perceived_duration: dur,
        rating_duration_s: Math.round((Date.now() - t0.current) / 1000), device_type: "mobile",
        comments: comments.trim() || null,
      });
      onDone();
    } catch (e) { Alert.alert("Submission failed", e.message); }
    finally { setBusy(false); }
  }
  const setR = (k) => (v) => setRt((p) => ({ ...p, [k]: v }));
  return (
    <Card visible={visible} onClose={onClose} title="Rate your route experience" subtitle={`Rating your ${optionsLabel}`}>
      <Section label="Safety feel"><Stars value={rt.safety_rating} onChange={setR("safety_rating")} /></Section>
      <Section label="Road quality"><Stars value={rt.road_rating} onChange={setR("road_rating")} /></Section>
      <Section label="Avoided dead-ends"><Stars value={rt.deadend_rating} onChange={setR("deadend_rating")} /></Section>
      <Section label="Overall trip satisfaction"><Stars value={rt.overall_rating} onChange={setR("overall_rating")} /></Section>
      <Section label="Would you use this route again?">
        <View style={{ flexDirection: "row", gap: 8 }}>
          {[[true, "👍 Yes", colors.green], [false, "👎 No", colors.red]].map(([v, l, c]) => (
            <TouchableOpacity key={l} onPress={() => setAgain(v)} style={[m.chip, { flex: 1 }, again === v && { backgroundColor: c + "26", borderColor: c }]}>
              <Text style={[m.chipText, again === v && { color: c }]}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>
      <Section label="Journey felt…">
        <View style={{ flexDirection: "row", gap: 5 }}>
          {DUR.map(([v, l]) => (
            <TouchableOpacity key={v} onPress={() => setDur(v)} style={[m.chip, { flex: 1, paddingHorizontal: 3 }, dur === v && { backgroundColor: "rgba(99,102,241,.15)", borderColor: colors.accent }]}>
              <Text style={[m.chipText, { fontSize: 8, textAlign: "center" }, dur === v && { color: colors.accentHi }]}>{l.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>
      <Section label="Comments (optional)">
        <TextInput style={m.ta} multiline value={comments} onChangeText={setComments} placeholder="Any observations…" placeholderTextColor={colors.txtDim} maxLength={1000} />
      </Section>
      <Actions onCancel={onClose} onSubmit={submit} busy={busy} />
    </Card>
  );
}

export function ReportModal({ location, onClose, onDone }) {
  const [type, setType] = useState(null);
  const [sev, setSev] = useState("medium");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!type) return Alert.alert("Pick an issue type first.");
    setBusy(true);
    try {
      const d = await api.submitReport({
        latitude: location.lat, longitude: location.lon, issue_type: type, severity: sev,
        description: desc.trim() || null, device_type: "mobile",
      });
      onDone(d.snapped_to_road
        ? "Report submitted — linked to nearest road ✓"
        : "Report submitted ✓ (too far from a mapped road to affect routing)");
    } catch (e) { Alert.alert("Submission failed", e.message); }
    finally { setBusy(false); }
  }
  return (
    <Card visible onClose={onClose} title="Report an issue" subtitle={`${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}>
      <Section label="What's the issue?">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {ISSUE_TYPES.map((t) => (
            <TouchableOpacity key={t.key} onPress={() => setType(t.key)} style={[m.chip, { width: "48.7%", alignItems: "flex-start" }, type === t.key && { backgroundColor: "rgba(99,102,241,.15)", borderColor: colors.accent }]}>
              <Text style={{ fontFamily: F.ui, fontSize: 11, color: type === t.key ? colors.accentHi : colors.txtMuted }}>{t.icon} {t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>
      <Section label="Severity">
        <View style={{ flexDirection: "row", gap: 6 }}>
          {SEVERITIES.map((v) => (
            <TouchableOpacity key={v} onPress={() => setSev(v)} style={[m.chip, { flex: 1 }, sev === v && { backgroundColor: SEV_COLOR[v] + "26", borderColor: SEV_COLOR[v] }]}>
              <Text style={[m.chipText, sev === v && { color: SEV_COLOR[v] }]}>{v.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>
      <Section label="Description (optional)">
        <TextInput style={m.ta} multiline value={desc} onChangeText={setDesc} maxLength={500} placeholder="e.g. deep pothole in the middle lane, streetlight out for 2 weeks…" placeholderTextColor={colors.txtDim} />
      </Section>
      <Actions onCancel={onClose} onSubmit={submit} busy={busy} submitLabel="Submit report" />
    </Card>
  );
}

const m = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", padding: 16 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border2, borderRadius: rLg, padding: 22, maxHeight: "92%" },
  h3: { fontFamily: F.head, fontSize: 15, color: colors.txt, marginBottom: 4 },
  sub: { fontFamily: F.mono, fontSize: 9, color: colors.txtMuted, marginBottom: 16, letterSpacing: 0.3 },
  lbl: { fontFamily: F.mono, fontSize: 9, color: colors.txtMuted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 },
  chip: { paddingVertical: 8, paddingHorizontal: 6, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: r, alignItems: "center", justifyContent: "center" },
  chipText: { fontFamily: F.mono, fontSize: 10, color: colors.txtMuted, letterSpacing: 0.3 },
  ta: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: r, color: colors.txt, padding: 10, fontFamily: F.ui, fontSize: 12, minHeight: 60, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 7, justifyContent: "flex-end", marginTop: 6 },
  btn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: r, minWidth: 80, alignItems: "center" },
  btnText: { fontFamily: F.head, fontSize: 12, color: "#fff" },
});
