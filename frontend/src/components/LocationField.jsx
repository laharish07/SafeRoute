import React, { useState, useRef, useEffect } from "react";
import { geocodeSearch } from "../api/geocode.js";

export default function LocationField({ label, icon, value, onSelect, onClickToSet, isPickingOnMap }) {
  const [query, setQuery] = useState(value?.label || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    setQuery(value?.label || "");
  }, [value]);

  function handleChange(e) {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const r = await geocodeSearch(q);
      setResults(r);
      setOpen(r.length > 0);
    }, 350);
  }

  function pick(r) {
    onSelect({ lat: r.lat, lon: r.lon, label: r.label });
    setQuery(r.label);
    setOpen(false);
  }

  return (
    <div className="location-field">
      <span className="location-field__icon">{icon}</span>
      <input
        value={query}
        onChange={handleChange}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={label}
        aria-label={label}
      />
      <button
        type="button"
        className={`location-field__pick-btn${isPickingOnMap ? " is-active" : ""}`}
        onClick={onClickToSet}
        title="Pick on map"
      >
        {isPickingOnMap ? "Tap map…" : "📍"}
      </button>

      {open && (
        <ul className="location-field__results">
          {results.map((r, i) => (
            <li key={i} onMouseDown={() => pick(r)}>
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
