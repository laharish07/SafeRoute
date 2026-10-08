// OsmMap — Leaflet + standard OpenStreetMap tiles inside a WebView.
// Same renderer as the static frontend (backend/static/js/app.js), so it looks identical and
// does not depend on Google/Apple maps (which is what left the native map blank in Expo Go).
//
// RN → web:  injectJavaScript("window.setState({...})")
// web → RN:  postMessage({type:"ready"|"click", lat, lng})
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { geomToLatLngs, routeParts } from "../geo";
import { ISSUE_TYPES, RQ_COLOR_MAP, SEV_COLOR, NEWS_SEV_COLOR } from "../theme";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
 html,body,#map{height:100%;margin:0;background:#e5e3df}
 .leaflet-control-attribution{font-size:10px}
 .em{font-size:20px;line-height:1;text-align:center}
 .crime{width:18px;height:18px;border-radius:50%;background:rgba(239,68,68,.35);border:1.5px solid #ef4444;box-sizing:border-box}
 #err{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#0d1117;color:#e2e8f0;font:13px sans-serif;text-align:center;padding:24px;z-index:9999}
</style></head><body>
<div id="map"></div><div id="err">Map library failed to load.<br/>Check the phone's internet connection.</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  function post(o){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  if (typeof L === "undefined") { document.getElementById("err").style.display="flex"; post({type:"error"}); return; }

  var map = L.map("map",{zoomControl:false,attributionControl:true}).setView([12.9716,77.5946],12);
  map.attributionControl.setPrefix(false);
  map.attributionControl.setPosition("topleft");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(map);

  var routeLayer=L.layerGroup().addTo(map), ovl=L.layerGroup().addTo(map), pins=L.layerGroup().addTo(map);
  var lastFit=null;

  function emoji(ch,size,anchor,glow){
    return L.divIcon({className:"",iconAnchor:anchor,iconSize:null,
      html:'<div class="em" style="font-size:'+size+'px;'+(glow?'filter:drop-shadow(0 0 3px '+glow+')':'')+'">'+ch+'</div>'});
  }

  window.setState = function(s){
    routeLayer.clearLayers(); ovl.clearLayers(); pins.clearLayers();

    var flat=[]; (s.route||[]).forEach(function(part){ L.polyline(part,{color:s.color,weight:6,opacity:.9,lineCap:"round",lineJoin:"round"}).addTo(routeLayer); flat=flat.concat(part); });

    (s.rq||[]).forEach(function(g){ var l=L.polyline(g.pts,{color:g.color,weight:4,opacity:.8}).addTo(ovl); l.bindPopup("🛣 "+g.label); });
    (s.crime||[]).forEach(function(p){
      L.marker([p.lat,p.lon],{icon:L.divIcon({className:"",html:'<div class="crime"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(ovl).bindPopup("🚨 Crime hotspot");
    });
    (s.deadends||[]).forEach(function(p){ L.marker([p.lat,p.lon],{icon:emoji("⚠️",14,[7,7])}).addTo(ovl).bindPopup("🚫 Dead end"); });
    (s.reports||[]).forEach(function(r){ L.marker([r.lat,r.lon],{icon:emoji(r.icon,16,[8,8],r.color)}).addTo(ovl).bindPopup(r.tip); });
    (s.news||[]).forEach(function(a){ L.marker([a.lat,a.lon],{icon:emoji("📰",15,[8,8],a.color)}).addTo(ovl).bindPopup(a.tip); });

    if (s.src) L.marker([s.src.lat,s.src.lon],{icon:emoji("📍",22,[11,22])}).addTo(pins);
    if (s.dst) L.marker([s.dst.lat,s.dst.lon],{icon:emoji("🏁",22,[11,22])}).addTo(pins);
    if (s.me)  L.circleMarker([s.me.lat,s.me.lon],{radius:7,color:"#fff",weight:2,fillColor:"#3b82f6",fillOpacity:1}).addTo(pins);

    if (s.fitKey && s.fitKey!==lastFit){
      lastFit=s.fitKey;
      var o={paddingTopLeft:[40,s.padTop],paddingBottomRight:[40,s.padBottom],animate:true,maxZoom:17};
      if (flat.length>1) map.fitBounds(L.latLngBounds(flat),o);
      else if (s.src && s.dst) map.fitBounds(L.latLngBounds([[s.src.lat,s.src.lon],[s.dst.lat,s.dst.lon]]),o);
      else if (s.src||s.dst){ var p=s.src||s.dst; map.setView([p.lat,p.lon],15,{animate:true}); }
    }
  };

  map.on("click",function(e){ post({type:"click",lat:e.latlng.lat,lng:e.latlng.lng}); });
  post({type:"ready"});
})();
</script></body></html>`;

export default function OsmMap({ src, dst, me, onMapPress, route, routeColor, overlays, overlayData, padTop, padBottom }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const clickRef = useRef(onMapPress);
  clickRef.current = onMapPress;

  const state = useMemo(() => {
    const issue = (k) => ISSUE_TYPES.find((t) => t.key === k) || { icon: "📢", label: k };
    const rt = routeParts(route);                       // array of separate line parts
    const flat = rt.flat();
    const fitKey = flat.length > 1 ? `r${flat.length}:${flat[0]}:${flat[flat.length - 1]}`
      : src && dst ? `p${src.lat},${src.lon}|${dst.lat},${dst.lon}`
      : src ? `s${src.lat},${src.lon}` : dst ? `d${dst.lat},${dst.lon}` : null;

    return {
      src: src && { lat: src.lat, lon: src.lon },
      dst: dst && { lat: dst.lat, lon: dst.lon },
      me: me || null,
      route: rt, color: routeColor, fitKey, padTop, padBottom,
      crime: overlays.has("crime") ? (overlayData.crime || []).map((p) => ({ lat: p.lat, lon: p.lon })) : [],
      deadends: overlays.has("deadendovl") ? (overlayData.deadendovl || []).map((p) => ({ lat: p.lat, lon: p.lon })) : [],
      rq: overlays.has("roadquality")
        ? (overlayData.roadquality || []).flatMap((seg) => {
            let g; try { g = typeof seg.geometry === "string" ? JSON.parse(seg.geometry) : seg.geometry; } catch { return []; }
            const pts = geomToLatLngs(g).map((p) => [p.latitude, p.longitude]);
            return pts.length > 1 ? [{ pts, color: RQ_COLOR_MAP[seg.highway] || "#94a3b8", label: esc(seg.highway || "unknown") }] : [];
          })
        : [],
      reports: overlays.has("reportsovl")
        ? (overlayData.reportsovl || []).map((r) => {
            const m = issue(r.issue_type);
            return {
              lat: r.lat, lon: r.lon, icon: m.icon, color: SEV_COLOR[r.severity] || "#818cf8",
              tip: `${m.icon} ${esc(m.label)} · ${esc(r.severity)}${r.description ? `<br/><i>${esc(r.description)}</i>` : ""}`,
            };
          })
        : [],
      news: overlays.has("newsovl")
        ? (overlayData.newsovl || []).filter((a) => a.lat != null && a.lon != null).map((a) => ({
            lat: a.lat, lon: a.lon, color: NEWS_SEV_COLOR[a.severity] || "#ef4444",
            tip: `📰 ${esc(a.headline)}<br/><span style="opacity:.65">${esc(a.crime_type)}${a.source ? " · " + esc(a.source) : ""}</span>`,
          }))
        : [],
    };
  }, [src, dst, me, route, routeColor, overlays, overlayData, padTop, padBottom]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`window.setState(${JSON.stringify(state)});true;`);
  }, [ready, state]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={ref}
        style={styles.web}
        originWhitelist={["*"]}
        source={{ html: HTML, baseUrl: "https://localhost/" }}   // baseUrl gives OSM tiles a valid Referer
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        overScrollMode="never"
        bounces={false}
        androidLayerType="hardware"
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.type === "ready") setReady(true);
            else if (m.type === "click") clickRef.current?.({ latitude: m.lat, longitude: m.lng });
          } catch {}
        }}
        onError={(e) => console.warn("Map WebView error", e.nativeEvent)}
      />
    </View>
  );
}

const styles = StyleSheet.create({ web: { flex: 1, backgroundColor: "#e5e3df" } });
