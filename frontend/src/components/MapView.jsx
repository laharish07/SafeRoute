import React, { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  Tooltip,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";

const BENGALURU_CENTER = [12.9352, 77.6146]; // South Bengaluru

const MODE_COLOR = {
  safe: "#34D399",
  fastest: "#6C8CFF",
  optimal: "#FBBF24",
  shortest: "#C084FC",
};

const ISSUE_ICON = {
  pothole: "🕳",
  lighting: "💡",
  road_condition: "🛣",
  dead_end: "🚧",
  obstruction: "⛔",
  crime: "🚨",
  flooding: "🌊",
  other: "❓",
};

const SEVERITY_COLOR = { low: "#34D399", medium: "#FBBF24", high: "#F87171" };

function pinIcon(emoji, color) {
  return L.divIcon({
    className: "",
    html: `<div style="font-size:20px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))">${emoji}</div>`,
    iconAnchor: [10, 20],
  });
}

function dotIcon(emoji, color) {
  return L.divIcon({
    className: "",
    html: `<div style="font-size:15px;line-height:1;filter:drop-shadow(0 0 3px ${color})">${emoji}</div>`,
    iconAnchor: [8, 8],
  });
}

/** Captures map clicks and forwards them up — used for click-to-set
 * source/destination and for report-an-issue pin drop. */
function ClickCapture({ onMapClick }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng);
    },
  });
  return null;
}

/** Recenters the map when the source/destination pair changes. */
function AutoFit({ src, dst, geometry }) {
  const map = useMap();
  React.useEffect(() => {
    if (geometry) {
      const coords = geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      if (coords.length > 1) {
        map.fitBounds(L.latLngBounds(coords), { padding: [80, 80] });
        return;
      }
    }
    if (src && dst) {
      map.fitBounds(L.latLngBounds([
        [src.lat, src.lon],
        [dst.lat, dst.lon],
      ]), { padding: [100, 100] });
    } else if (src) {
      map.setView([src.lat, src.lon], 15);
    }
  }, [src?.lat, src?.lon, dst?.lat, dst?.lon, geometry]);
  return null;
}

export default function MapView({
  src,
  dst,
  clickMode,
  onMapClick,
  routes,
  selectedMode,
  overlays,
  overlayData,
}) {
  const selectedGeometry = useMemo(() => {
    const r = routes?.[selectedMode];
    return r?.features?.[0]?.geometry || null;
  }, [routes, selectedMode]);

  return (
    <MapContainer
      center={BENGALURU_CENTER}
      zoom={13}
      zoomControl={false}
      className="map-canvas"
      style={{ width: "100%", height: "100%" }}
    >
      {/*
        Standard OSM tiles rather than a themed CDN (e.g. CartoDB) —
        tile.openstreetmap.org is the single most universally-reachable
        Leaflet tile source (no API key, essentially never blocked by ad
        blockers/firewalls the way some other tile CDNs can be). The dark
        look is approximated with a CSS filter on the tile layer instead
        of depending on a dark-specific CDN being reachable.
      */}
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        className="map-tiles--dark"
      />

      <ClickCapture onMapClick={onMapClick} />
      <AutoFit src={src} dst={dst} geometry={selectedGeometry} />

      {/* ── Route polylines — selected mode bold, others dimmed ── */}
      {routes &&
        Object.entries(routes).map(([mode, route]) => {
          const geom = route?.features?.[0]?.geometry;
          if (!geom) return null;
          const positions = geom.coordinates.map(([lon, lat]) => [lat, lon]);
          const isSelected = mode === selectedMode;
          return (
            <Polyline
              key={mode}
              positions={positions}
              pathOptions={{
                color: MODE_COLOR[mode] || "#6C8CFF",
                weight: isSelected ? 6 : 3,
                opacity: isSelected ? 0.95 : 0.35,
              }}
            />
          );
        })}

      {/* ── Source / destination markers ── */}
      {src && (
        <Marker position={[src.lat, src.lon]} icon={pinIcon("📍")}>
          <Tooltip direction="top">Source</Tooltip>
        </Marker>
      )}
      {dst && (
        <Marker position={[dst.lat, dst.lon]} icon={pinIcon("🏁")}>
          <Tooltip direction="top">Destination</Tooltip>
        </Marker>
      )}

      {/* ── Overlay: historical crime hotspots ── */}
      {overlays.has("crime") &&
        (overlayData.crime || []).map((p, i) => (
          <CircleMarker
            key={`crime-${i}`}
            center={[p.lat, p.lon]}
            radius={6}
            pathOptions={{ color: "#F87171", fillColor: "#F87171", fillOpacity: 0.5 }}
          >
            <Tooltip>Historical crime hotspot</Tooltip>
          </CircleMarker>
        ))}

      {/* ── Overlay: dead ends ── */}
      {overlays.has("deadendovl") &&
        (overlayData.deadendovl || []).map((p, i) => (
          <Marker key={`de-${i}`} position={[p.lat, p.lon]} icon={dotIcon("🚧", "#FBBF24")}>
            <Tooltip>Dead end</Tooltip>
          </Marker>
        ))}

      {/* ── Overlay: road quality ── */}
      {overlays.has("roadquality") &&
        (overlayData.roadquality || []).map((seg, i) => {
          if (!seg.geometry) return null;
          let geom;
          try {
            geom = JSON.parse(seg.geometry);
          } catch {
            return null;
          }
          const positions = geom.coordinates.map(([lon, lat]) => [lat, lon]);
          return (
            <Polyline
              key={`rq-${i}`}
              positions={positions}
              pathOptions={{ color: "#94A3B8", weight: 4, opacity: 0.8 }}
            />
          );
        })}

      {/* ── Overlay: community reports ── */}
      {overlays.has("reportsovl") &&
        (overlayData.reportsovl || []).map((r) => (
          <Marker
            key={`rep-${r.id}`}
            position={[r.lat, r.lon]}
            icon={dotIcon(ISSUE_ICON[r.issue_type] || "📢", SEVERITY_COLOR[r.severity] || "#6C8CFF")}
          >
            <Tooltip>
              {ISSUE_ICON[r.issue_type] || "📢"} {r.issue_type} · {r.severity}
              {r.description ? ` — ${r.description}` : ""}
            </Tooltip>
          </Marker>
        ))}

      {/* ── Overlay: live news ── */}
      {overlays.has("newsovl") &&
        (overlayData.newsovl || []).map((a) => {
          if (a.lat == null || a.lon == null) return null;
          return (
            <Marker
              key={`news-${a.id}`}
              position={[a.lat, a.lon]}
              icon={dotIcon("📰", SEVERITY_COLOR[a.severity] || "#F87171")}
            >
              <Tooltip>
                📰 {a.headline}
                <br />
                <span style={{ opacity: 0.7 }}>
                  {a.crime_type} · {a.source || "unknown source"}
                </span>
              </Tooltip>
            </Marker>
          );
        })}
    </MapContainer>
  );
}
