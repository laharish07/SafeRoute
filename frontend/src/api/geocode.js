// api/geocode.js
//
// Nominatim search — same geocoding service the original server-rendered
// frontend credited in its footer ("Geocoding via Nominatim"). Client-side
// here since there's no reason to proxy it through the Flask backend.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Bounding box around greater Bengaluru (min_lon, max_lat, max_lon, min_lat).
const BENGALURU_VIEWBOX = "77.35,13.15,77.85,12.75";

export async function geocodeSearch(query) {
  if (!query || query.trim().length < 3) return [];
  const params = new URLSearchParams({
    format: "json",
    q: query,
    viewbox: BENGALURU_VIEWBOX,
    // bounded=1 makes the viewbox a HARD restriction — without this,
    // Nominatim treats it as a soft preference only and will happily
    // return a same-named place anywhere on Earth (this is why searches
    // were returning results in Greece). countrycodes is a second,
    // independent filter on top of that.
    bounded: "1",
    countrycodes: "in",
    limit: "5",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}
