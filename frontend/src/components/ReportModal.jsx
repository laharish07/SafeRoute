import React, { useState } from "react";
import { api } from "../api/client.js";

const ISSUE_TYPES = [
  { key: "pothole", icon: "🕳", label: "Pothole" },
  { key: "lighting", icon: "💡", label: "Broken/No Light" },
  { key: "road_condition", icon: "🛣", label: "Poor Road" },
  { key: "dead_end", icon: "🚧", label: "Dead End" },
  { key: "obstruction", icon: "⛔", label: "Obstruction" },
  { key: "crime", icon: "🚨", label: "Unsafe / Crime" },
  { key: "flooding", icon: "🌊", label: "Flooding" },
  { key: "other", icon: "❓", label: "Other" },
];
const SEVERITIES = ["low", "medium", "high"];

export default function ReportModal({ location, onClose }) {
  const [issueType, setIssueType] = useState(null);
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    if (!issueType) {
      setError("Pick an issue type first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.submitReport({
        latitude: location.lat,
        longitude: location.lon,
        issue_type: issueType,
        severity,
        description: description.trim() || undefined,
        device_type: "web",
      });
      setResult(res);
    } catch (e) {
      setError(e.message || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {result ? (
          <>
            <h3>Thanks — report submitted</h3>
            <p className="modal__subtitle">
              {result.snapped_to_road
                ? "Linked to the nearest road and will factor into future routes."
                : "Saved, but it's too far from a mapped road to affect routing."}
            </p>
            <div className="modal-actions">
              <button className="btn-submit" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Report an issue</h3>
            <p className="modal__subtitle">
              {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
            </p>

            <div className="modal-section">
              <label>What's the issue?</label>
              <div className="issue-type-grid">
                {ISSUE_TYPES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={`issue-type-btn${issueType === t.key ? " is-active" : ""}`}
                    onClick={() => setIssueType(t.key)}
                  >
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <label>Severity</label>
              <div className="severity-row">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`severity-btn severity-btn--${s}${severity === s ? " is-active" : ""}`}
                    onClick={() => setSeverity(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <label>Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. deep pothole in the middle lane, streetlight out for 2 weeks…"
              />
            </div>

            {error && <div className="modal-error">{error}</div>}

            <div className="modal-actions">
              <button className="btn-cancel" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-submit" onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Submitting…" : "Submit report"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
