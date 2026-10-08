# heuristic.py
# Provides an A* heuristic factor for pgr_aStar.
# The factor scales the built-in Euclidean heuristic to account for
# crime density and lighting at night, while remaining admissible (<= 1.25).

import math
from db import get_conn, dict_cur

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BENGALURU_DIAMETER_M = 50_000   # normalisation denominator for base distance
MAX_MULTIPLIER       = 1.25     # hard cap — keeps heuristic admissible

NIGHT_START_HOUR = 20
NIGHT_END_HOUR   = 6

MODE_COEFFICIENTS = {
    "safe":    {"crime": 0.15, "lighting": 0.10},
    "optimal": {"crime": 0.08, "lighting": 0.05},
    "fastest": {"crime": 0.02, "lighting": 0.00},
}

# ---------------------------------------------------------------------------
# Zone cache  {area_name: {crime_idx, lighting_idx}}
# ---------------------------------------------------------------------------

_zone_cache: dict[str, dict] = {}


def build_zone_index() -> None:
    """Populate _zone_cache from DB.  Call once at server startup."""
    conn = get_conn()
    cur  = dict_cur(conn)

    try:
        # Crime index per area (normalised to [0, 1])
        cur.execute("""
            SELECT
                LOWER(TRIM(area)) AS area,
                COUNT(*)::float / NULLIF(MAX(COUNT(*)) OVER (), 0) AS crime_idx
            FROM south_crime_raw
            WHERE area IS NOT NULL
            GROUP BY area
        """)
        for row in cur.fetchall():
            _zone_cache.setdefault(row["area"], {})["crime_idx"] = float(row["crime_idx"])

        # Lighting index per road name (normalised to [0, 1])
        cur.execute("""
            SELECT
                LOWER(TRIM(r.name)) AS area,
                COUNT(lrl.lighting_id)::float /
                    NULLIF(MAX(COUNT(lrl.lighting_id)) OVER (), 0) AS lighting_idx
            FROM lighting_road_link lrl
            JOIN osm_roads r ON r.id = lrl.road_id
            WHERE r.name IS NOT NULL
            GROUP BY r.name
        """)
        for row in cur.fetchall():
            _zone_cache.setdefault(row["area"], {})["lighting_idx"] = float(row["lighting_idx"])

        print(f"[heuristic] zone index built: {len(_zone_cache)} areas")

    finally:
        cur.close()
        from db import release_conn
        release_conn(conn)


# ---------------------------------------------------------------------------
# Zone lookup for a coordinate
# ---------------------------------------------------------------------------

def _lookup_zone(lat: float, lon: float) -> dict:
    """Return crime_idx / lighting_idx for the nearest area to (lat, lon)."""
    conn = get_conn()
    cur  = dict_cur(conn)

    try:
        cur.execute(
            """
            SELECT LOWER(TRIM(area)) AS area
            FROM south_crime_raw
            WHERE latitude  IS NOT NULL
              AND longitude IS NOT NULL
            ORDER BY
                ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
                <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            LIMIT 1
            """,
            (float(lon), float(lat)),
        )
        row = cur.fetchone()
    finally:
        cur.close()
        from db import release_conn
        release_conn(conn)

    if row and row["area"] in _zone_cache:
        return _zone_cache[row["area"]]

    # Fallback: global average of cache
    if _zone_cache:
        vals = list(_zone_cache.values())
        return {
            "crime_idx":    sum(v.get("crime_idx",    0.3) for v in vals) / len(vals),
            "lighting_idx": sum(v.get("lighting_idx", 0.5) for v in vals) / len(vals),
        }

    return {"crime_idx": 0.3, "lighting_idx": 0.5}


# ---------------------------------------------------------------------------
# Haversine distance (metres)
# ---------------------------------------------------------------------------

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2.0 * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Main heuristic function
# ---------------------------------------------------------------------------

def heuristic(
    node_lat: float,
    node_lon: float,
    goal_lat: float,
    goal_lon: float,
    hour:     int   = 14,
    w_safety: float = 0.4,
    mode:     str   = "optimal",
) -> float:
    """
    Returns a factor >= 1.0 for pgr_aStar's `factor` parameter.

    The factor inflates the built-in Euclidean heuristic when:
      - The destination area has high crime.
      - It is night-time and the area is poorly lit.

    Capped at MAX_MULTIPLIER (1.25) to keep the heuristic admissible.
    """

    # 1. Normalised straight-line distance to goal
    dist_m = _haversine_m(node_lat, node_lon, goal_lat, goal_lon)
    base_h = dist_m / BENGALURU_DIAMETER_M      # [0, ~1]

    # 2. Zone safety at the goal location
    zone        = _lookup_zone(goal_lat, goal_lon)
    crime_idx   = zone.get("crime_idx",    0.3)
    lighting_idx= zone.get("lighting_idx", 0.5)

    coeffs = MODE_COEFFICIENTS.get(mode, MODE_COEFFICIENTS["optimal"])

    # 3. Crime multiplier
    crime_mult = 1.0 + crime_idx * coeffs["crime"]

    # 4. Night-time + lighting multiplier
    is_night  = hour >= NIGHT_START_HOUR or hour < NIGHT_END_HOUR
    dark_frac = 1.0 - lighting_idx
    time_mult = 1.0 + float(is_night) * dark_frac * coeffs["lighting"]

    # 5. Combine and cap
    raw_mult   = crime_mult * time_mult
    final_mult = min(raw_mult, MAX_MULTIPLIER)

    factor = 1.0 + base_h * (final_mult - 1.0)
    return min(factor, MAX_MULTIPLIER)