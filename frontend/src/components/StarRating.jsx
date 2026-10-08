import React from "react";

export default function StarRating({ label, value, onChange }) {
  return (
    <div className="star-rating">
      <span className="star-rating__label">{label}</span>
      <div className="star-rating__stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`star-rating__star${n <= value ? " is-filled" : ""}`}
            onClick={() => onChange(n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            ★
          </button>
        ))}
      </div>
    </div>
  );
}
