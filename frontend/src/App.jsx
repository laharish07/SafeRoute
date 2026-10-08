import React, { useState, useEffect, useCallback } from "react";
import MapView from "./components/MapView.jsx";
import TopBar from "./components/TopBar.jsx";
import SearchPanel from "./components/SearchPanel.jsx";
import RouteRail from "./components/RouteRail.jsx";
import ReportModal from "./components/ReportModal.jsx";
import FeedbackModal from "./components/FeedbackModal.jsx";
import { api } from "./api/client.js";

const OVERLAY_FETCHERS = {
  crime: (coords) => api.getCrimeOnRoute(coords).then((d) => d.points || []),
  deadendovl: (coords) => api.getDeadEndsOnRoute(coords).then((d) => d.points || []),
  roadquality: (coords) => api.getRoadQualityOnRoute(coords).then((d) => d.segments || []),
  reportsovl: (coords) => api.getReportsOnRoute(coords).then((d) => d.reports || []),
  newsovl: (coords) => api.getNewsOnRoute(coords).then((d) => d.articles || []),
};

function routeToCoords(route) {
  const geom = route?.features?.[0]?.geometry;
  if (!geom) return [];
  return geom.coordinates.map(([lon, lat]) => [lat, lon]);
}

export default function App() {
  const [src, setSrc] = useState(null);
  const [dst, setDst] = useState(null);
  const [clickMode, setClickMode] = useState(null); // 'src' | 'dst' | 'report' | null

  const [routes, setRoutes] = useState(null);
  const [selectedMode, setSelectedMode] = useState("safe");
  const [loading, setLoading] = useState(false);

  const [overlays, setOverlays] = useState(new Set());
  const [overlayData, setOverlayData] = useState({});

  const [newsStatus, setNewsStatus] = useState(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const [reportLocation, setReportLocation] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [briefing, setBriefing] = useState(null);

  // ── Live feed badge, polled every 5 minutes ──
  useEffect(() => {
    const load = () => api.getNewsStatus().then(setNewsStatus).catch(() => {});
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Map click handling: set src/dst, or drop a report pin ──
  const handleMapClick = useCallback(
    (latlng) => {
      if (clickMode === "src") {
        setSrc({ lat: latlng.lat, lon: latlng.lng, label: "Dropped pin" });
        setClickMode(null);
      } else if (clickMode === "dst") {
        setDst({ lat: latlng.lat, lon: latlng.lng, label: "Dropped pin" });
        setClickMode(null);
      } else if (clickMode === "report") {
        setReportLocation({ lat: latlng.lat, lon: latlng.lng });
        setClickMode(null);
      }
    },
    [clickMode]
  );

  // ── Compute routes ──
  async function findRoutes() {
    if (!src || !dst) return;
    setLoading(true);
    setBriefing(null);
    try {
      const hour = new Date().getHours();
      const result = await api.getMultiRoute({
        source: { lat: src.lat, lon: src.lon },
        destination: { lat: dst.lat, lon: dst.lon },
        hour,
      });
      setRoutes(result);
      // default to the safe mode if it routed, else whichever did
      const firstAvailable = ["safe", "fastest", "optimal", "shortest"].find(
        (m) => result?.[m]?.features?.length
      );
      setSelectedMode(firstAvailable || "safe");
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  // ── Overlay toggling — fetch on first enable, cache after that ──
  async function toggleOverlay(key) {
    const next = new Set(overlays);
    if (next.has(key)) {
      next.delete(key);
      setOverlays(next);
      return;
    }
    next.add(key);
    setOverlays(next);

    if (!overlayData[key] && routes) {
      const coords = routeToCoords(routes[selectedMode]);
      try {
        const data = await OVERLAY_FETCHERS[key](coords);
        setOverlayData((prev) => ({ ...prev, [key]: data }));
      } catch (e) {
        console.error(`overlay ${key} failed`, e);
      }
    }
  }

  // ── AI route briefing ──
  async function askAI(mode) {
    const route = routes?.[mode];
    const props = route?.features?.[0]?.properties;
    if (!props) return;

    setBriefing({ loading: true });
    try {
      const coords = routeToCoords(route);
      const result = await api.getRouteBriefing({
        route: props,
        route_coords: coords,
        hour: new Date().getHours(),
        mode,
      });
      if (result.available) {
        setBriefing({ available: true, text: result.briefing, sources_used: result.sources_used });
      } else {
        setBriefing({ available: false, reason: result.reason });
      }
    } catch (e) {
      setBriefing({ available: false, reason: e.message });
    }
  }

  function openReportFlow() {
    setClickMode("report");
  }

  return (
    <div className="app-shell">
      <TopBar newsStatus={newsStatus} onReportClick={openReportFlow} />

      <div className="app-body">
        <SearchPanel
          src={src}
          dst={dst}
          setSrc={setSrc}
          setDst={setDst}
          clickMode={clickMode}
          setClickMode={setClickMode}
          onFindRoutes={findRoutes}
          loading={loading}
          overlays={overlays}
          toggleOverlay={toggleOverlay}
          collapsed={panelCollapsed}
          onToggleCollapsed={() => setPanelCollapsed((c) => !c)}
        />

        <main className="map-area">
          <MapView
            src={src}
            dst={dst}
            clickMode={clickMode}
            onMapClick={handleMapClick}
            routes={routes}
            selectedMode={selectedMode}
            overlays={overlays}
            overlayData={overlayData}
          />

          {clickMode === "report" && (
            <div className="map-hint">Tap the map to place your report</div>
          )}

          <RouteRail
            routes={routes}
            selectedMode={selectedMode}
            onSelectMode={setSelectedMode}
            briefing={briefing}
            onAskAI={askAI}
            onRate={() => setShowFeedback(true)}
          />
        </main>
      </div>

      {reportLocation && (
        <ReportModal location={reportLocation} onClose={() => setReportLocation(null)} />
      )}

      {showFeedback && routes && (
        <FeedbackModal
          src={src}
          dst={dst}
          route={routes[selectedMode]}
          mode={selectedMode}
          onClose={() => setShowFeedback(false)}
        />
      )}
    </div>
  );
}
