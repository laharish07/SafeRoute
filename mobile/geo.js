// GeoJSON helpers — LineString and MultiLineString (ST_LineMerge may return the latter).
export function geomToLatLngs(geom) {
  if (!geom) return [];
  const pt = ([lon, lat]) => ({ latitude: lat, longitude: lon });
  if (geom.type === "LineString") return geom.coordinates.map(pt);
  if (geom.type === "MultiLineString") return geom.coordinates.flatMap((s) => s.map(pt));
  return [];
}
export const routeLatLngs = (route) => geomToLatLngs(route?.features?.[0]?.geometry);
export const routeProps = (route) => route?.features?.[0]?.properties || {};
// Backend overlay endpoints expect [[lat, lon], ...]
export const routeToCoords = (route) => routeLatLngs(route).map((p) => [p.latitude, p.longitude]);

// Route as separate parts [[ [lat,lon], ... ], ...] — a MultiLineString must NOT be joined end-to-end
// (that draws false connecting lines between disjoint road pieces). Leaflet draws each part on its own.
export function routeParts(route) {
  const geom = route?.features?.[0]?.geometry;
  if (!geom) return [];
  const conv = (line) => line.map(([lon, lat]) => [lat, lon]);
  if (geom.type === "LineString") return [conv(geom.coordinates)];
  if (geom.type === "MultiLineString") return geom.coordinates.map(conv).filter((p) => p.length > 1);
  return [];
}
