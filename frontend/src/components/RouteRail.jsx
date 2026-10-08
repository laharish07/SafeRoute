import React from "react";
import RouteCard from "./RouteCard.jsx";
import AIBriefing from "./AIBriefing.jsx";

const MODE_ORDER = ["safe", "fastest", "optimal", "shortest"];

export default function RouteRail({
  routes,
  selectedMode,
  onSelectMode,
  briefing,
  onAskAI,
  onRate,
}) {
  if (!routes) return null;

  return (
    <div className="route-rail">
      <div className="route-rail__cards">
        {MODE_ORDER.map((mode) => (
          <RouteCard
            key={mode}
            mode={mode}
            route={routes[mode]}
            isSelected={mode === selectedMode}
            onSelect={onSelectMode}
            onAskAI={onAskAI}
          />
        ))}
        <button className="route-rail__rate-btn" onClick={onRate}>
          ⭐ Rate this trip
        </button>
      </div>

      {briefing && <AIBriefing briefing={briefing} />}
    </div>
  );
}
