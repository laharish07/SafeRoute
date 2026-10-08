// Bangalore-aware Nominatim geocoding — ported from backend/static/js/app.js.
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REVERSE = "https://nominatim.openstreetmap.org/reverse";
const BOX = "77.3,12.7,77.9,13.3";
const HEADERS = { "Accept-Language": "en", "User-Agent": "SafeRoute-Capstone/1.0" };

const TYPE_ICON = {
  hospital: "🏥", school: "🏫", college: "🎓", university: "🎓", restaurant: "🍽", cafe: "☕", fast_food: "🍔",
  bar: "🍺", hotel: "🏨", hostel: "🏨", motel: "🏨", supermarket: "🛒", mall: "🏬", shop: "🛍", park: "🌳",
  garden: "🌳", stadium: "🏟", bus_stop: "🚌", metro_station: "🚇", railway_station: "🚂", temple: "🛕",
  mosque: "🕌", church: "⛪", pharmacy: "💊", bank: "🏦", atm: "💳", police: "👮", fire_station: "🚒",
  residential: "🏘", suburb: "🏘", neighbourhood: "🏘", road: "🛣", street: "🛣", amenity: "📍", default: "📍",
};
const TYPE_LABEL = {
  residential: "Area", suburb: "Area", neighbourhood: "Locality", quarter: "Locality", city_district: "District",
  road: "Road", street: "Road", motorway: "Highway", amenity: "Place", shop: "Shop", tourism: "Place",
  hospital: "Hospital", school: "School", college: "College", university: "University", park: "Park",
  bus_stop: "Bus Stop", metro_station: "Metro", railway: "Railway",
};
const ADMIN = ["bruhat", "bbmp", "mahanagara", "palike", "karnataka", "india", "bangalore urban"];
const isAdmin = (n) => ADMIN.some((a) => n.toLowerCase().includes(a));

function mainLabel(r) {
  const a = r.address || {};
  const name = r.name || r.display_name?.split(",")[0]?.trim() || "";
  if (name && !isAdmin(name)) return name;
  return (
    a.neighbourhood || a.quarter || a.suburb || a.village || a.city_district ||
    (a.road ? a.road + (a.suburb ? ", " + a.suburb : "") : null) ||
    name || r.display_name?.split(",")[0]?.trim() || "Unknown"
  );
}
function subLabel(r, main) {
  const a = r.address || {};
  const c = [a.suburb, a.neighbourhood, a.quarter, a.city_district, a.county, a.city || a.town || "Bengaluru"]
    .filter(Boolean).filter((v) => v !== main && !isAdmin(v));
  return c.filter((v, i) => c.indexOf(v) === i).slice(0, 2).join(", ");
}
function dedup(results) {
  const seen = new Set();
  return results.filter((r) => {
    const key = `${parseFloat(r.lat).toFixed(3)},${parseFloat(r.lon).toFixed(3)}|${mainLabel(r).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Returns [{main, sub, icon, type, lat, lon, label}] */
export async function searchPlaces(q) {
  const qBlr = /bangalore|bengaluru|blr/i.test(q) ? q : `${q}, Bangalore`;
  const base = `${NOMINATIM}?q=${encodeURIComponent(qBlr)}&format=json&limit=8&viewbox=${BOX}&countrycodes=in&addressdetails=1`;
  let data = await (await fetch(`${base}&bounded=1`, { headers: HEADERS })).json();
  if (data.length < 2) {
    const data2 = await (await fetch(`${base}&bounded=0`, { headers: HEADERS })).json();
    data = dedup([...data, ...data2]).slice(0, 8);
  } else data = dedup(data);

  return data.map((r) => {
    const main = mainLabel(r);
    const sub = subLabel(r, main);
    const t = r.type || r.class || "";
    const tl = r.type || r.class || r.addresstype || "";
    return {
      main, sub,
      icon: TYPE_ICON[t] || TYPE_ICON[r.addresstype || ""] || TYPE_ICON.default,
      type: TYPE_LABEL[tl] || (tl ? tl.charAt(0).toUpperCase() + tl.slice(1).replace(/_/g, " ") : "Place"),
      lat: parseFloat(r.lat), lon: parseFloat(r.lon),
      label: main + (sub ? ", " + sub.split(",")[0] : ""),
    };
  });
}

export async function reverseGeocode(lat, lon) {
  try {
    const d = await (await fetch(`${REVERSE}?lat=${lat}&lon=${lon}&format=json&zoom=17&addressdetails=1`, { headers: HEADERS })).json();
    if (!d?.address) return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const a = d.address, name = d.name || "";
    const locality = a.neighbourhood || a.suburb || a.quarter || a.city_district || "";
    if (name && !isAdmin(name)) return locality ? `${name}, ${locality}` : name;
    const area = a.city_district || a.county || "Bengaluru";
    return locality ? `${locality}, ${area}` : area;
  } catch {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}

// Recent searches (in memory for the session, max 5 per field)
const recents = { src: [], dst: [] };
export const getRecents = (f) => recents[f];
export const saveRecent = (f, item) => { recents[f] = [item, ...recents[f].filter((x) => x.label !== item.label)].slice(0, 5); };
export const clearRecents = (f) => { recents[f] = []; };
