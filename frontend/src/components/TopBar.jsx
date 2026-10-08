import React from "react";

function formatAgo(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

export default function TopBar({ newsStatus, onReportClick }) {
  let feedLabel = "📰 Live feed: checking…";
  let feedClass = "";

  if (newsStatus) {
    if (!newsStatus.auto_refresh_enabled) {
      feedLabel = "📰 Live feed: disabled";
      feedClass = "is-off";
    } else if (!newsStatus.last_fetched_at) {
      feedLabel = "📰 Live feed: first fetch pending";
      feedClass = "is-stale";
    } else {
      const ago = formatAgo(newsStatus.last_fetched_at);
      feedLabel = `📰 Live feed: updated ${ago} · ${newsStatus.total_articles} articles`;
      feedClass = "is-live";
    }
  }

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__logo">🛡</span>
        <span className="top-bar__name">SafeRoute</span>
        <span className="top-bar__subtitle">Bengaluru</span>
      </div>

      <div className={`top-bar__feed-badge ${feedClass}`}>{feedLabel}</div>

      <button className="top-bar__report-btn" onClick={onReportClick}>
        + Report an issue
      </button>
    </header>
  );
}
