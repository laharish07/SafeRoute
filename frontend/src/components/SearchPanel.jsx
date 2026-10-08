import React from "react";
import LocationField from "./LocationField.jsx";

const OVERLAYS = [
  { key: "crime", icon: "🔴", label: "Crime hotspots" },
  { key: "deadendovl", icon: "🚧", label: "Dead ends" },
  { key: "roadquality", icon: "🛣", label: "Road quality" },
  { key: "reportsovl", icon: "📢", label: "Community reports" },
  { key: "newsovl", icon: "📰", label: "Live news" },
];

export default function SearchPanel({
  src,
  dst,
  setSrc,
  setDst,
  clickMode,
  setClickMode,
  onFindRoutes,
  loading,
  overlays,
  toggleOverlay,
  collapsed,
  onToggleCollapsed,
}) {
  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setSrc({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: "My location",
        });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  return (
    <aside className={`search-panel${collapsed ? " is-collapsed" : ""}`}>
      <button className="search-panel__collapse-btn" onClick={onToggleCollapsed}>
        {collapsed ? "›" : "‹"}
      </button>

      {!collapsed && (
        <div className="search-panel__body">
          <div className="search-panel__fields">
            <LocationField
              label="Source"
              icon="📍"
              value={src}
              onSelect={setSrc}
              onClickToSet={() => setClickMode(clickMode === "src" ? null : "src")}
              isPickingOnMap={clickMode === "src"}
            />
            <button className="search-panel__gps-btn" onClick={useMyLocation}>
              ⌖ Use my location
            </button>
            <LocationField
              label="Destination"
              icon="🏁"
              value={dst}
              onSelect={setDst}
              onClickToSet={() => setClickMode(clickMode === "dst" ? null : "dst")}
              isPickingOnMap={clickMode === "dst"}
            />
          </div>

          <button
            className="search-panel__find-btn"
            onClick={onFindRoutes}
            disabled={!src || !dst || loading}
          >
            {loading ? "Finding routes…" : "Find Routes"}
          </button>

          <div className="search-panel__overlays">
            <h3>Map layers</h3>
            {OVERLAYS.map((o) => (
              <label key={o.key} className="overlay-toggle">
                <input
                  type="checkbox"
                  checked={overlays.has(o.key)}
                  onChange={() => toggleOverlay(o.key)}
                />
                <span className="overlay-toggle__icon">{o.icon}</span>
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
