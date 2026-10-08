import React from "react";

export default function AIBriefing({ briefing }) {
  if (briefing.loading) {
    return (
      <div className="ai-briefing ai-briefing--loading">
        <span className="ai-briefing__spinner" />
        Generating AI safety briefing…
      </div>
    );
  }

  if (!briefing.available) {
    return (
      <div className="ai-briefing ai-briefing--unavailable">
        ✨ AI briefing unavailable — {briefing.reason || "not configured"}
      </div>
    );
  }

  return (
    <div className="ai-briefing">
      <div className="ai-briefing__header">
        <span>✨ AI Safety Briefing</span>
        {briefing.sources_used && (
          <span className="ai-briefing__sources">
            grounded in {briefing.sources_used.reports} live report
            {briefing.sources_used.reports === 1 ? "" : "s"} +{" "}
            {briefing.sources_used.news} news article
            {briefing.sources_used.news === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <p>{briefing.text}</p>
    </div>
  );
}
