# reports.py
#
# Community-reported road issues: potholes, broken/missing lighting, poor
# road condition, dead ends / obstructions, crime / unsafe incidents,
# flooding, other.
#
# Reports are snapped to the nearest routable road edge at submission time
# (like lighting_road_link / pothole_road_link already do for bulk data),
# so they can be folded into the routing cost model — see the report_*
# CTEs added to build_cost_sql() in cost_engine.py — and can also be
# queried back out for map overlays.

from db import get_conn, release_conn, dict_cur
from cache_refresh import refresh_dynamic_views

VALID_ISSUE_TYPES = {
    "pothole", "lighting", "road_condition",
    "dead_end", "obstruction", "crime", "flooding", "other",
}
VALID_SEVERITIES = {"low", "medium", "high"}
VALID_STATUSES = {"pending", "verified", "resolved", "rejected"}

# Reports farther than this from any routable edge are still saved
# (road_id stays NULL) but won't influence routing.
SNAP_MAX_DISTANCE_M = 60

MAX_DESCRIPTION_LEN = 500


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def _snap_nearest_road(cur, lon, lat):
    """Return (road_id, distance_m) for the nearest routable edge, or (None, distance_m)."""
    cur.execute(
        """
        SELECT r.id AS road_id,
               ST_Distance(
                   r.geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
               ) AS distance_m
        FROM osm_roads r
        ORDER BY r.geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
        LIMIT 1
        """,
        (lon, lat, lon, lat),
    )
    row = cur.fetchone()
    if not row:
        return None, None
    if row["distance_m"] is None or row["distance_m"] > SNAP_MAX_DISTANCE_M:
        return None, row["distance_m"]
    return row["road_id"], row["distance_m"]


# ─────────────────────────────────────────────
# CREATE
# ─────────────────────────────────────────────
def create_report(
    *,
    latitude,
    longitude,
    issue_type,
    severity="medium",
    description=None,
    session_id=None,
    device_type="web",
):
    """Insert a new report, snapping it to the nearest road edge. Raises ValueError on bad input."""
    issue_type = (issue_type or "").strip().lower()
    severity = (severity or "medium").strip().lower()

    if issue_type not in VALID_ISSUE_TYPES:
        raise ValueError(f"issue_type must be one of {sorted(VALID_ISSUE_TYPES)}")
    if severity not in VALID_SEVERITIES:
        raise ValueError(f"severity must be one of {sorted(VALID_SEVERITIES)}")

    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        raise ValueError("latitude/longitude must be numeric")

    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise ValueError("latitude/longitude out of range")

    description = (description or "").strip()[:MAX_DESCRIPTION_LEN] or None

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)

        road_id, distance_m = _snap_nearest_road(cur, lon, lat)

        cur.execute(
            """
            INSERT INTO user_reports (
                latitude, longitude, geom,
                issue_type, severity, description,
                road_id, distance_m,
                session_id, device_type
            ) VALUES (
                %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                %s, %s, %s,
                %s, %s,
                %s, %s
            )
            RETURNING id, reported_at
            """,
            (
                lat, lon, lon, lat,
                issue_type, severity, description,
                road_id, distance_m,
                session_id, device_type,
            ),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()

        if road_id is not None:
            # Only worth refreshing the cache if this report actually
            # landed on a road (i.e. can affect routing at all).
            # Non-blocking-ish: a fast CONCURRENTLY refresh, not a
            # full recompute — see cache_refresh.py.
            refresh_dynamic_views()

        return {
            "id": row["id"],
            "reported_at": row["reported_at"].isoformat(),
            "road_id": road_id,
            "snapped_to_road": road_id is not None,
            "distance_to_road_m": round(distance_m, 1) if distance_m is not None else None,
        }

    except ValueError:
        raise
    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# READ — along a route (for the map overlay)
# ─────────────────────────────────────────────
def reports_near_coords(coords, radius_m=120, issue_types=None, limit=200):
    """
    Reports within `radius_m` metres of a route polyline.
    `coords` is a list of [lat, lon] pairs — same shape used by the
    existing /api/crime/route, /api/deadends/route, /api/roadquality/route.
    """
    if not coords:
        return []

    linestring = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in coords) + ")"

    type_filter_sql = ""
    params = [linestring, radius_m]
    if issue_types:
        cleaned = [t for t in issue_types if t in VALID_ISSUE_TYPES]
        if cleaned:
            type_filter_sql = "AND ur.issue_type = ANY(%s)"
            params.append(cleaned)

    params.append(limit)

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute(
            f"""
            WITH route AS (SELECT ST_GeomFromText(%s, 4326) AS geom)
            SELECT
                ur.id, ur.latitude, ur.longitude,
                ur.issue_type, ur.severity, ur.description,
                ur.status, ur.reported_at
            FROM user_reports ur, route rt
            WHERE ur.status IN ('pending', 'verified')
              AND ST_DWithin(ur.geom, rt.geom::geography, %s)
              {type_filter_sql}
            ORDER BY ur.reported_at DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
        cur.close()
        return [_serialize(r) for r in rows]
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# READ — near a point (for browsing the map)
# ─────────────────────────────────────────────
def reports_nearby(lat, lon, radius_m=500, issue_types=None, limit=100):
    type_filter_sql = ""
    params = [lon, lat, radius_m]
    if issue_types:
        cleaned = [t for t in issue_types if t in VALID_ISSUE_TYPES]
        if cleaned:
            type_filter_sql = "AND issue_type = ANY(%s)"
            params.append(cleaned)
    params.append(limit)

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute(
            f"""
            SELECT id, latitude, longitude, issue_type, severity,
                   description, status, reported_at
            FROM user_reports
            WHERE status IN ('pending', 'verified')
              AND ST_DWithin(
                    geom,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    %s
                  )
              {type_filter_sql}
            ORDER BY reported_at DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
        cur.close()
        return [_serialize(r) for r in rows]
    finally:
        release_conn(conn)


def _serialize(r):
    return {
        "id": r["id"],
        "lat": r["latitude"],
        "lon": r["longitude"],
        "issue_type": r["issue_type"],
        "severity": r["severity"],
        "description": r["description"],
        "status": r["status"],
        "reported_at": r["reported_at"].isoformat(),
    }
