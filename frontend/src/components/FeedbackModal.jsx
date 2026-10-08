import React, { useState, useRef, useEffect } from "react";
import StarRating from "./StarRating.jsx";
import { api } from "../api/client.js";

const PERCEIVED_OPTIONS = [
  { value: "faster_than_expected", label: "Faster than expected" },
  { value: "as_expected", label: "As expected" },
  { value: "slower_than_expected", label: "Slower than expected" },
];

export default function FeedbackModal({ src, dst, route, mode, onClose }) {
  const [safety, setSafety] = useState(0);
  const [road, setRoad] = useState(0);
  const [deadend, setDeadend] = useState(0);
  const [wouldUseAgain, setWouldUseAgain] = useState(null);
  const [perceived, setPerceived] = useState("");
  const [comments, setComments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  const props = route?.features?.[0]?.properties;

  async function handleSubmit() {
    if (!safety || !road || !deadend) {
      setError("Please rate safety, road quality, and dead-ends.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.submitFeedback({
        src_lat: src.lat,
        src_lon: src.lon,
        dst_lat: dst.lat,
        dst_lon: dst.lon,
        safety_rating: safety,
        road_rating: road,
        deadend_rating: deadend,
        overall_rating: Math.round((safety + road + deadend) / 3),
        would_use_again: wouldUseAgain,
        perceived_duration: perceived || undefined,
        route_length: props?.distance_km,
        trip_duration: props?.eta_min,
        route_options: mode,
        rating_duration_s: Math.round((Date.now() - openedAt.current) / 1000),
        device_type: "web",
      });
      onClose(true);
    } catch (e) {
      setError(e.message || "Submission failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal">
        <h3>Rate this trip</h3>
        <p className="modal__subtitle">Your ratings help the system learn safer, better routes.</p>

        <StarRating label="Safety" value={safety} onChange={setSafety} />
        <StarRating label="Road quality" value={road} onChange={setRoad} />
        <StarRating label="Dead-end experience" value={deadend} onChange={setDeadend} />

        <div className="modal-section">
          <label>Would you take this route again?</label>
          <div className="toggle-row">
            <button
              className={wouldUseAgain === true ? "is-active" : ""}
              onClick={() => setWouldUseAgain(true)}
            >
              Yes
            </button>
            <button
              className={wouldUseAgain === false ? "is-active" : ""}
              onClick={() => setWouldUseAgain(false)}
            >
              No
            </button>
          </div>
        </div>

        <div className="modal-section">
          <label>How was the travel time?</label>
          <select value={perceived} onChange={(e) => setPerceived(e.target.value)}>
            <option value="">— optional —</option>
            {PERCEIVED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="modal-section">
          <label>Comments (optional)</label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Anything else worth mentioning?"
          />
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-cancel" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button className="btn-submit" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit rating"}
          </button>
        </div>
      </div>
    </div>
  );
}
