import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { colors, F, r, rLg } from "../theme";
import { searchPlaces, getRecents, saveRecent, clearRecents } from "../api/geocode";

function Highlight({ text, q }) {
  if (!q) return <Text style={s.main} numberOfLines={1}>{text}</Text>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <Text style={s.main} numberOfLines={1}>{text}</Text>;
  return (
    <Text style={s.main} numberOfLines={1}>
      {text.slice(0, i)}<Text style={{ color: colors.accentHi, fontFamily: F.uiSemi }}>{text.slice(i, i + q.length)}</Text>{text.slice(i + q.length)}
    </Text>
  );
}

export default function LocationField({ field, label, confirmed, value, onPlace, onClear, pickActive, onPick, onFocus, pinIcon, extra }) {
  const [text, setText] = useState(value?.label || "");
  const [items, setItems] = useState(null);   // null = closed, [] = no results, array = results
  const [recents, setRecents] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const reqId = useRef(0);

  // Pin dropped / "My location" / cleared externally → reflect in the input
  useEffect(() => { if (value?.label) setText(value.label); }, [value?.label]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function onChange(t) {
    setText(t);
    onClear(true);                // typing invalidates the confirmed pin (same as web)
    clearTimeout(timer.current);
    const q = t.trim();
    if (!q) { showRecents(); return; }
    setRecents(false);
    if (q.length < 2) { setItems(null); return; }
    setLoading(true);
    const id = ++reqId.current;
    timer.current = setTimeout(async () => {
      try {
        const res = await searchPlaces(q);
        if (id === reqId.current) setItems(res);
      } catch { if (id === reqId.current) setItems("error"); }
      finally { if (id === reqId.current) setLoading(false); }
    }, 300);
  }
  function showRecents() { if (getRecents(field).length) { setRecents(true); setItems(null); } else { setRecents(false); setItems(null); } }
  function pick(p) {
    onPlace({ lat: p.lat, lon: p.lon, label: p.label });
    saveRecent(field, { lat: p.lat, lon: p.lon, label: p.label, sub: p.sub });
    setItems(null); setRecents(false);
  }

  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.row}>
        <View style={s.box}>
          <TextInput
            style={s.input} value={text} onChangeText={onChange}
            onFocus={() => { onFocus?.(); if (!text.trim()) showRecents(); else if (Array.isArray(items) && items.length) setItems(items); }}
            placeholder="Area, landmark or address…" placeholderTextColor={colors.txtDim}
            autoCorrect={false} autoCapitalize="none" spellCheck={false}
          />
          {loading ? <ActivityIndicator size="small" color={colors.txtMuted} style={s.clear} /> :
            !!text && (
              <TouchableOpacity style={s.clear} hitSlop={10} onPress={() => { setText(""); onClear(false); setItems(null); setRecents(false); }}>
                <Text style={{ color: colors.txtMuted, fontSize: 15 }}>×</Text>
              </TouchableOpacity>
            )}
        </View>
        <TouchableOpacity style={[s.pin, pickActive && s.pinOn]} onPress={onPick}>
          <Text style={{ fontSize: 13 }}>{pinIcon}</Text>
        </TouchableOpacity>
      </View>
      {confirmed && <Text style={s.ok}>✓ {label} set</Text>}
      {extra}

      {(recents || items !== null) && (
        <View style={s.dd}>
          {recents && (
            <>
              <View style={s.ddHd}>
                <Text style={s.ddHdText}>RECENT</Text>
                <TouchableOpacity onPress={() => { clearRecents(field); setRecents(false); }}><Text style={s.ddHdText}>CLEAR</Text></TouchableOpacity>
              </View>
              {getRecents(field).map((it, i) => (
                <TouchableOpacity key={i} style={s.item} onPress={() => { onPlace({ lat: it.lat, lon: it.lon, label: it.label }); setRecents(false); }}>
                  <Text style={s.icon}>🕐</Text>
                  <View style={{ flex: 1 }}><Text style={s.main} numberOfLines={1}>{it.label}</Text>{!!it.sub && <Text style={s.sub} numberOfLines={1}>{it.sub}</Text>}</View>
                  <Text style={s.type}>RECENT</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
          {items === "error" && <Text style={s.none}>Search failed — check connection</Text>}
          {Array.isArray(items) && items.length === 0 && (
            <View style={{ padding: 14, alignItems: "center" }}>
              <Text style={{ fontSize: 20, opacity: 0.4 }}>🔍</Text>
              <Text style={{ color: colors.txtMuted, fontFamily: F.ui, fontSize: 12, marginTop: 4 }}>No results in Bangalore</Text>
              <Text style={{ color: colors.txtDim, fontFamily: F.mono, fontSize: 9, marginTop: 3 }}>Try a neighbourhood, landmark or road name</Text>
            </View>
          )}
          {Array.isArray(items) && items.map((p, i) => (
            <TouchableOpacity key={i} style={[s.item, i === items.length - 1 && { borderBottomWidth: 0 }]} onPress={() => pick(p)}>
              <Text style={s.icon}>{p.icon}</Text>
              <View style={{ flex: 1 }}>
                <Highlight text={p.main} q={text.trim()} />
                {!!p.sub && <Text style={s.sub} numberOfLines={1}>{p.sub}</Text>}
              </View>
              <Text style={s.type}>{p.type.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  label: { fontFamily: F.monoMed, fontSize: 9, color: colors.txtMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 },
  row: { flexDirection: "row", gap: 5, alignItems: "center" },
  box: { flex: 1, justifyContent: "center" },
  input: {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: r, color: colors.txt,
    fontFamily: F.ui, fontSize: 13, paddingVertical: 8, paddingLeft: 10, paddingRight: 28, height: 38,
  },
  clear: { position: "absolute", right: 8 },
  pin: { width: 38, height: 38, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: r },
  pinOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  ok: { fontFamily: F.mono, fontSize: 9, color: colors.green, marginTop: 2 },
  dd: { marginTop: 5, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border2, borderRadius: rLg, overflow: "hidden" },
  ddHd: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 11, paddingTop: 7, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
  ddHdText: { fontFamily: F.mono, fontSize: 8, color: colors.txtDim, letterSpacing: 0.7 },
  item: { flexDirection: "row", gap: 9, alignItems: "center", paddingVertical: 8, paddingHorizontal: 11, borderBottomWidth: 1, borderBottomColor: "rgba(37,46,68,0.5)" },
  icon: { fontSize: 13, width: 18, textAlign: "center", opacity: 0.85 },
  main: { fontFamily: F.uiSemi, fontSize: 12, color: colors.txt },
  sub: { fontFamily: F.ui, fontSize: 10, color: colors.txtMuted, marginTop: 1 },
  type: { fontFamily: F.mono, fontSize: 8, color: colors.txtDim, backgroundColor: colors.border, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  none: { padding: 12, textAlign: "center", color: colors.txtMuted, fontFamily: F.mono, fontSize: 11 },
});
