// Draggable bottom sheet (the mobile stand-in for the static frontend's sidebar).
// Drag the header to snap between peek / half / full. No extra native deps.
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, View, StyleSheet, Dimensions, Platform } from "react-native";
import { colors } from "../theme";

export default function BottomSheet({ heights, snap, onSnap, header, children, maxHeight }) {
  const h = useRef(new Animated.Value(heights[snap])).current;
  const cur = useRef(heights[snap]);
  const start = useRef(0);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const go = (to) => Animated.spring(h, { toValue: to, useNativeDriver: false, bounciness: 0, speed: 18 }).start();

  useEffect(() => { cur.current = heights[snap]; go(heights[snap]); }, [snap, heights[0], heights[1], heights[2]]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
    onPanResponderGrant: () => { h.stopAnimation((v) => { start.current = v; }); },
    onPanResponderMove: (_, g) => {
      const hs = heightsRef.current;
      h.setValue(Math.max(hs[0], Math.min(hs[2], start.current - g.dy)));
    },
    onPanResponderRelease: (_, g) => {
      const hs = heightsRef.current;
      const v = Math.max(hs[0], Math.min(hs[2], start.current - g.dy));
      const projected = v - g.vy * 120;          // flick momentum
      let best = 0;
      hs.forEach((x, i) => { if (Math.abs(x - projected) < Math.abs(hs[best] - projected)) best = i; });
      if (Math.abs(g.dy) < 4) best = snap === 2 ? 1 : snap + 1 > 2 ? 0 : snap + 1;   // tap cycles
      onSnap(best);
      go(hs[best]);
    },
  }), [snap]);

  return (
    <Animated.View style={[styles.sheet, { height: h, maxHeight }]}>
      <View {...pan.panHandlers}>
        <View style={styles.grab} />
        {header}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border,
    overflow: "hidden", elevation: 16, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: -6 },
  },
  grab: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border2, marginTop: 8, marginBottom: 2 },
});
