import json
import psycopg2.extras
from db import get_conn, release_conn
from cost_engine import build_cost_sql
from heuristic import heuristic, build_zone_index


# ─────────────────────────────────────────────
# INIT
# ─────────────────────────────────────────────
try:
    build_zone_index()
except Exception as _e:
    print(f"[routing] zone index skipped: {_e}")


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def _snap_node(cur, lon, lat):
    cur.execute("""
        SELECT v.id
        FROM osm_roads_vertices_pgr v
        WHERE v.id IN (SELECT node FROM main_component_nodes)
        ORDER BY v.the_geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
        LIMIT 1
    """, (lon, lat))
    row = cur.fetchone()
    return row["id"] if row else None


def _get_node_coords(cur, node_id):
    cur.execute("""
        SELECT ST_Y(the_geom) AS lat, ST_X(the_geom) AS lon
        FROM osm_roads_vertices_pgr
        WHERE id = %s
    """, (node_id,))
    row = cur.fetchone()
    return (row["lat"], row["lon"]) if row else None


def _normalize(val):
    if val is None:
        return 0.0
    return max(0.0, min(1.0, float(val)))


# ─────────────────────────────────────────────
# EDGE CHECK
# ─────────────────────────────────────────────
def _check_edge_count(cur, conn, cost_sql):
    try:
        cur.execute(f"""
            SELECT COUNT(*) AS n
            FROM (
                {cost_sql}
            ) AS edges
            WHERE edges.cost > 0
        """)
        row = cur.fetchone()
        n = int(row["n"] if row else 0)
        print(f"[routing] edge count: {n}")
        return n
    except Exception as e:
        print(f"[routing] edge check failed: {e}")
        conn.rollback()
        return -1


# ─────────────────────────────────────────────
# ROUTING LAYERS
# ─────────────────────────────────────────────
def _astar_edges(cur, cost_sql, src, dst, factor, directed):
    try:
        sql = f"""
            SELECT r.edge
            FROM pgr_aStar(
                $$ {cost_sql} $$,
                %s,
                %s,
                directed := {'true' if directed else 'false'},
                heuristic := 2,
                factor := %s
            ) r
            WHERE r.edge > 0
            ORDER BY r.seq
        """
        cur.execute(sql, (src, dst, factor))
        return cur.fetchall()
    except Exception as e:
        print(f"[routing] A* failed (directed={directed}): {e}")
        cur.connection.rollback()
        return []


def _dijkstra_edges(cur, src, dst):
    try:
        simple_sql = """
            SELECT id, source, target,
                   COALESCE(NULLIF(cost, 0), ST_Length(geom::geography)) AS cost,
                   CASE WHEN reverse_cost < 0 THEN -1
                        ELSE COALESCE(NULLIF(cost, 0), ST_Length(geom::geography))
                   END AS reverse_cost
            FROM osm_roads
        """
        sql = f"""
            SELECT r.edge
            FROM pgr_dijkstra(
                $$ {simple_sql} $$,
                %s,
                %s,
                directed := false
            ) r
            WHERE r.edge > 0
            ORDER BY r.seq
        """
        cur.execute(sql, (src, dst))
        return cur.fetchall()
    except Exception as e:
        print(f"[routing] Dijkstra failed: {e}")
        cur.connection.rollback()
        return []


# ─────────────────────────────────────────────
# GEOMETRY
# ─────────────────────────────────────────────
def _geometry_for_edges(cur, edge_ids):
    if not edge_ids:
        return None

    try:
        cur.execute("""
    WITH crime_agg AS (
        SELECT
            crl.road_id,
            LN(
                1 + (
                    SUM(crl.crime_risk_score)
                    / GREATEST(SUM(ST_Length(o.geom::geography)), 50)
                )
            ) AS raw_crime
        FROM crime_road_link crl
        JOIN osm_roads o ON o.id = crl.road_id
        WHERE crl.road_id = ANY(%s)
        GROUP BY crl.road_id
    ),
    crime_max AS (
        SELECT COALESCE(MAX(raw_crime), 1.0) AS v FROM crime_agg
    ),
    edge_data AS (
        SELECT
            o.geom,
            ST_Length(o.geom::geography) AS seg_len,
            (LEAST(1.0,
    COALESCE(ca.raw_crime, 0) / NULLIF(cm.v, 0.0001)
)) AS safety_score
        FROM osm_roads o
        LEFT JOIN crime_agg ca ON ca.road_id = o.id
        CROSS JOIN crime_max cm
        WHERE o.id = ANY(%s)
    )
    SELECT
        ST_AsGeoJSON(ST_LineMerge(ST_Union(geom))) AS geometry,
        SUM(seg_len) AS total_length,
        SUM(safety_score * seg_len) / NULLIF(SUM(seg_len), 0) AS avg_safety
    FROM edge_data
""", (edge_ids, edge_ids))

        return cur.fetchone()

    except Exception as e:
        print(f"[routing] geometry error: {e}")
        cur.connection.rollback()
        return None


# ─────────────────────────────────────────────
# MAIN ROUTE
# ─────────────────────────────────────────────
def compute_route(
    src_lon, src_lat,
    dst_lon, dst_lat,
    w_safety=0.4,
    w_road=0.3,
    w_deadend=0.3,
    w_distance=0.0,     # ← explicit distance weight (0 = no extra scaling, 1 = shortest)
    hour=14,
    mode="optimal"
):
    """
    Compute a single route.

    Weight semantics (all in [0, 1]):
        w_distance  – prefer shorter paths (1.0 = pure shortest path)
        w_safety    – avoid crime hotspots
        w_road      – prefer better road types
        w_deadend   – avoid dead-end streets
    Weights are additive; they need not sum to 1.
    """

    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        src_node = _snap_node(cur, src_lon, src_lat)
        dst_node = _snap_node(cur, dst_lon, dst_lat)

        if not src_node or not dst_node:
            print("[routing] snap failed")
            return None

        goal = _get_node_coords(cur, dst_node)
        src  = _get_node_coords(cur, src_node)

        if not goal:
            goal = (dst_lat, dst_lon)
        if not src:
            src = (src_lat, src_lon)

        print(f"[routing] SRC={src_node} DST={dst_node} mode={mode} "
              f"w_dist={w_distance} w_safe={w_safety} w_road={w_road} w_dead={w_deadend}")

        factor = heuristic(
            node_lat=src[0], node_lon=src[1],
            goal_lat=goal[0], goal_lon=goal[1],
            hour=hour, w_safety=w_safety, mode=mode
        )
        factor = max(0.5, min(2.0, factor))

        # Pass w_distance to cost SQL builder
        cost_sql = build_cost_sql(w_safety, w_road, w_deadend, w_distance)

        _check_edge_count(cur, conn, cost_sql)

        edges = _astar_edges(cur, cost_sql, src_node, dst_node, factor, True)

        if not edges:
            edges = _astar_edges(cur, cost_sql, src_node, dst_node, factor, False)

        if not edges:
            edges = _dijkstra_edges(cur, src_node, dst_node)

        if not edges:
            print("[routing] no route found")
            return None

        edge_ids = [int(e["edge"]) for e in edges if e["edge"] is not None]

        if not edge_ids:
            return None

        row = _geometry_for_edges(cur, edge_ids)
        if not row or not row["geometry"]:
            return None

        geometry = json.loads(row["geometry"])
        length   = float(row["total_length"] or 0)
        safety   = _normalize(row["avg_safety"])

        distance_km = length / 1000
        eta_min = (distance_km / 30) * 60
        safety_pct = round((1 - safety) * 100, 1)

        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "distance_km": round(distance_km, 2),
                    "eta_min":     round(eta_min, 1),
                    "safety_pct":  safety_pct,
                    "mode":        mode,
                    "factor":      round(factor, 4),
                }
            }]
        }

    except Exception as e:
        import traceback
        print("[routing ERROR]:", e)
        traceback.print_exc()
        conn.rollback()
        return None

    finally:
        cur.close()
        release_conn(conn)


# ─────────────────────────────────────────────
# MULTI ROUTE
# ─────────────────────────────────────────────
def compute_multi_route(
    src_lon, src_lat,
    dst_lon, dst_lat,
    hour=14,
    w_safety=0.25,
    w_road=0.65,
    w_deadend=0.1
):
    """
    Returns three named routes for backward-compat with /api/route/multi.
    The UI now calls /api/route directly for the new options flow.
    """

    print("[routing] multi-route start")

    shared = dict(
        src_lon=src_lon,
        src_lat=src_lat,
        dst_lon=dst_lon,
        dst_lat=dst_lat,
        hour=hour,
    )

    return {
        # Pure shortest path (w_distance=1, everything else=0)
        "shortest": compute_route(
            **shared,
            w_safety=0.0,
            w_road=0.0,
            w_deadend=0.0,
            w_distance=1.0,
            mode="shortest"
        ) or {"error": "no route"},

        # Safest path
        "safe": compute_route(
            **shared,
            w_safety=0.95,
            w_road=0.0,
            w_deadend=0.05,
            w_distance=0.0,
            mode="safe"
        ) or {"error": "no route"},

        # Fastest / best-road path
        "fastest": compute_route(
            **shared,
            w_safety=0.00,
            w_road=0.70,
            w_deadend=0.0,
            w_distance=0.30,
            mode="fastest"
        ) or {"error": "no route"},

        # Balanced optimal
        "optimal": compute_route(
            **shared,
            w_safety=w_safety,
            w_road=w_road,
            w_deadend=w_deadend,
            w_distance=0.10,
            mode="optimal"
        ) or {"error": "no route"},
    }