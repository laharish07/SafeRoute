import React from "react";

const MODE_META = {
  safe: { icon: "🛡", label: "Safest", color: "#34D399" },
  fastest: { icon: "⚡", label: "Fastest", color: "#6C8CFF" },
  optimal: { icon: "⭐", label: "Optimal", color: "#FBBF24" },
  shortest: { icon: "📏", label: "Shortest", color: "#C084FC" },
};

export default function RouteCard({ mode, route, isSelected, onSelect, onAskAI }) {
  const meta = MODE_META[mode] || { icon: "🧭", label: mode, color: "#6C8CFF" };
  const props = route?.features?.[0]?.properties;

  if (!props) {
    return (
      <div className="route-card route-card--unavailable">
        <span className="route-card__icon">{meta.icon}</span>
        <span className="route-card__label">{meta.label}</span>
        <span className="route-card__unavailable-text">No route found</span>
      </div>
    );
  }

  return (
    <button
      className={`route-card${isSelected ? " is-selected" : ""}`}
      style={{ "--mode-color": meta.color }}
      onClick={() => onSelect(mode)}
    >
      <div className="route-card__header">
        <span className="route-card__icon">{meta.icon}</span>
        <span className="route-card__label">{meta.label}</span>
      </div>

      <div className="route-card__stats">
        <div className="route-card__stat">
          <span className="route-card__stat-value">{props.distance_km}</span>
          <span className="route-card__stat-unit">km</span>
        </div>
        <div className="route-card__stat">
          <span className="route-card__stat-value">{props.eta_min}</span>
          <span className="route-card__stat-unit">min</span>
        </div>
        <div className="route-card__stat">
          <span className="route-card__stat-value">{props.safety_pct}%</span>
          <span className="route-card__stat-unit">safe</span>
        </div>
      </div>

      {props.ai_predicted_rating != null && (
        <div className="route-card__ai-badge">
          🤖 AI predicted rating: <strong>{props.ai_predicted_rating}/5</strong>
        </div>
      )}

      {isSelected && (
        <button
          className="route-card__ask-ai-btn"
          onClick={(e) => {
            e.stopPropagation();
            onAskAI(mode);
          }}
        >
          ✨ Why this route?
        </button>
      )}
    </button>
  );
}
