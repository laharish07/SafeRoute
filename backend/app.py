from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import os
import datetime
import threading
import psycopg2.extras

from routing import compute_route, compute_multi_route, _snap_node
from learning import get_suggested_weights, get_weights_for_options, invalidate_cache
from db import get_conn, dict_cur, release_conn
from reports import (
    create_report,
    reports_near_coords,
    reports_nearby,
    VALID_ISSUE_TYPES,
    VALID_SEVERITIES,
)
from news_ingest import (
    run_news_ingestion,
    backfill_past_month,
    recent_news,
    news_near_coords,
    ingestion_status,
    start_news_scheduler,
)
from cache_refresh import (
    refresh_static_views,
    refresh_dynamic_views,
    rebuild_dynamic_view_definitions,
    start_cache_refresh_scheduler,
)
import ml_model
from ai_briefing import generate_route_briefing

app = Flask(__name__)
CORS(app)


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def _clamp(v, lo=0.0, hi=1.0):
    try:
        return max(lo, min(hi, float(v)))
    except Exception:
        return lo


def _error(msg, code=400):
    return jsonify({"error": msg}), code


def _int_rating(val, key: str):
    """Parse and validate a 1–5 integer rating field."""
    try:
        v = int(val)
        if not 1 <= v <= 5:
            raise ValueError
        return v
    except (TypeError, ValueError):
        raise ValueError(f"'{key}' must be an integer between 1 and 5")


def _time_of_day_label(hour: int) -> str:
    if 5  <= hour < 12: return "morning"
    if 12 <= hour < 17: return "afternoon"
    if 17 <= hour < 21: return "evening"
    return "night"


# ─────────────────────────────────────────────
# FRONTEND
# ─────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


# ─────────────────────────────────────────────
# SINGLE ROUTE
# ─────────────────────────────────────────────
@app.route("/api/route", methods=["POST"])
def route():
    try:
        data = request.get_json(silent=True)
        if not data:
            return _error("Invalid JSON")

        src = data.get("source")
        dst = data.get("destination")
        if not src or not dst:
            return _error("Missing source/destination")

        result = compute_route(
            src_lon=float(src["lon"]),
            src_lat=float(src["lat"]),
            dst_lon=float(dst["lon"]),
            dst_lat=float(dst["lat"]),
            w_safety=_clamp(data.get("w_safety",    0.4)),
            w_road=_clamp(data.get("w_road",        0.3)),
            w_deadend=_clamp(data.get("w_deadend",  0.3)),
            w_distance=_clamp(data.get("w_distance", 0.0)),
            hour=int(data.get("hour", datetime.datetime.now().hour)),
            mode=str(data.get("mode", "optimal")),
        )

        if not result:
            return _error("No route found")

        return jsonify(result)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return _error(str(e))


# ─────────────────────────────────────────────
# MULTI ROUTE
# ─────────────────────────────────────────────
@app.route("/api/route/multi", methods=["POST"])
def multi_route():
    try:
        data = request.get_json(silent=True)
        if not data:
            return _error("Invalid JSON")

        src = data.get("source")
        dst = data.get("destination")
        if not src or not dst:
            return _error("Missing source/destination")

        hour    = int(data.get("hour", datetime.datetime.now().hour))
        tod     = _time_of_day_label(hour)
        learned = get_suggested_weights(time_of_day=tod)

        result = compute_multi_route(
            src_lon=float(src["lon"]),
            src_lat=float(src["lat"]),
            dst_lon=float(dst["lon"]),
            dst_lat=float(dst["lat"]),
            hour=hour,
            w_safety=_clamp(learned.get("w_safety",  0.4)),
            w_road=_clamp(learned.get("w_road",      0.3)),
            w_deadend=_clamp(learned.get("w_deadend", 0.3)),
        )

        if not result:
            return jsonify({"error": "Routing failed", "safe": None, "fastest": None, "optimal": None})

        # AI-predicted satisfaction per mode (GradientBoostingRegressor
        # trained on user_feedback — see ml_model.py). Each entry in
        # `result` is a GeoJSON FeatureCollection (or {"error": ...} if
        # that mode failed to route) — the actual distance/eta/safety
        # numbers live in features[0].properties, not on the dict
        # directly. Purely additive either way: if the model isn't
        # trained yet, ai_predicted_rating is just omitted and routing
        # itself is completely unaffected.
        for mode_key, route in result.items():
            if not route or "features" not in route or not route["features"]:
                continue
            props = route["features"][0]["properties"]
            predicted = ml_model.predict_satisfaction(
                route_length=props.get("distance_km"),
                trip_duration=props.get("eta_min"),
                route_option=mode_key,
                hour=hour,
            )
            if predicted is not None:
                props["ai_predicted_rating"] = predicted

        return jsonify(result)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "safe": None, "fastest": None, "optimal": None})


# ─────────────────────────────────────────────
# WEIGHTS  (GET + POST)
# ─────────────────────────────────────────────
@app.route("/api/weights", methods=["GET"])
def weights():
    """
    Return learned weights.

    Query params:
        time_of_day  — morning | afternoon | evening | night
        options      — comma-separated active option names, e.g. 'safety,road'
    """
    tod     = request.args.get("time_of_day") or None
    opts_raw= request.args.get("options", "")
    opts    = [o.strip() for o in opts_raw.split(",") if o.strip()] if opts_raw else []

    if opts:
        result = get_weights_for_options(opts, tod)
    else:
        result = get_suggested_weights(time_of_day=tod)

    return jsonify(result)


@app.route("/api/weights/all", methods=["GET"])
def weights_all():
    """
    Return learned weights for all four time-of-day bands in one call.
    Useful for the frontend time-of-day weight preview panel.
    """
    bands  = ["morning", "afternoon", "evening", "night"]
    opts_raw = request.args.get("options", "")
    opts   = [o.strip() for o in opts_raw.split(",") if o.strip()] if opts_raw else []

    result = {}
    for band in bands:
        if opts:
            result[band] = get_weights_for_options(opts, band)
        else:
            result[band] = get_suggested_weights(time_of_day=band)

    return jsonify(result)


# ─────────────────────────────────────────────
# FEEDBACK  (fully fixed + enriched)
# ─────────────────────────────────────────────
@app.route("/api/feedback", methods=["POST"])
def feedback():
    """
    Accept user feedback and persist it.

    Required fields:
        safety_rating, road_rating, deadend_rating  — integers 1–5
        src_lat, src_lon, dst_lat, dst_lon          — floats

    Optional fields:
        time_of_day        — string (derived server-side if absent)
        route_options      — string key, e.g. 'deadend+safety'
        route_length       — float km
        trip_duration      — float minutes
        route_edges        — list of edge IDs
        overall_rating     — int 1–5
        would_use_again    — bool
        perceived_duration — 'faster_than_expected' | 'as_expected' | 'slower_than_expected'
        rating_duration_s  — int seconds spent on rating screen
        session_id         — UUID string
        device_type        — 'web' | 'mobile'
        comments           — string (max 1000 chars)
    """
    data = request.get_json(silent=True)
    if not data:
        return _error("Invalid JSON")

    conn = None
    try:
        # ── Validate required ratings ──────────────────────────────────
        safety_rating  = _int_rating(data.get("safety_rating"),  "safety_rating")
        road_rating    = _int_rating(data.get("road_rating"),    "road_rating")
        deadend_rating = _int_rating(data.get("deadend_rating"), "deadend_rating")

        # ── Coordinates ────────────────────────────────────────────────
        src_lat = float(data["src_lat"])
        src_lon = float(data["src_lon"])
        dst_lat = float(data["dst_lat"])
        dst_lon = float(data["dst_lon"])

        # ── Optional enrichment ────────────────────────────────────────
        hour           = datetime.datetime.now().hour
        time_of_day    = data.get("time_of_day") or _time_of_day_label(hour)
        route_options  = data.get("route_options") or "shortest"
        route_length   = float(data["route_length"])   if data.get("route_length")   else None
        trip_duration  = float(data["trip_duration"])  if data.get("trip_duration")  else None
        overall_rating = _int_rating(data["overall_rating"], "overall_rating") \
                         if data.get("overall_rating") else None
        would_use_again = bool(data["would_use_again"]) \
                          if data.get("would_use_again") is not None else None
        perceived_dur  = data.get("perceived_duration") or None
        rating_secs    = int(data["rating_duration_s"]) if data.get("rating_duration_s") else None
        session_id     = data.get("session_id") or None
        device_type    = data.get("device_type") or "web"
        comments       = str(data.get("comments", ""))[:1000] or None

        # ── Route edges (array) ────────────────────────────────────────
        raw_edges  = data.get("route_edges")
        route_edges = [int(e) for e in raw_edges] if raw_edges else None

        # ── Snap coordinates → node IDs (server-side) ─────────────────
        conn = get_conn()
        snap_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        src_node = _snap_node(snap_cur, src_lon, src_lat)
        dst_node = _snap_node(snap_cur, dst_lon, dst_lat)
        snap_cur.close()

        # ── Validate perceived_duration ────────────────────────────────
        valid_pd = {"faster_than_expected", "as_expected", "slower_than_expected"}
        if perceived_dur and perceived_dur not in valid_pd:
            perceived_dur = None

        # ── Insert ─────────────────────────────────────────────────────
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO user_feedback (
                src_lat,        src_lon,
                dst_lat,        dst_lon,
                src_node,       dst_node,
                route_edges,
                safety_rating,  road_rating,    deadend_rating,
                overall_rating,
                would_use_again,
                perceived_duration,
                route_length,   trip_duration,
                time_of_day,    route_options,
                rating_duration_s,
                session_id,     device_type,
                comments
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s,
                %s,
                %s, %s, %s,
                %s,
                %s,
                %s,
                %s, %s,
                %s, %s,
                %s,
                %s, %s,
                %s
            )
            """,
            (
                src_lat,       src_lon,
                dst_lat,       dst_lon,
                src_node,      dst_node,
                route_edges,
                safety_rating, road_rating,    deadend_rating,
                overall_rating,
                would_use_again,
                perceived_dur,
                route_length,  trip_duration,
                time_of_day,   route_options,
                rating_secs,
                session_id,    device_type,
                comments,
            ),
        )
        conn.commit()
        cur.close()

        # Invalidate the learning cache so the next /api/weights call
        # reflects this new data immediately.
        invalidate_cache()

        # Retrain the AI satisfaction model in the background so this
        # submission doesn't have to wait on it — a GradientBoosting fit
        # is cheap at this data scale but there's no reason to make the
        # user's request latency depend on it.
        threading.Thread(target=ml_model.train_satisfaction_model, daemon=True).start()

        return jsonify({"status": "saved"})

    except ValueError as ve:
        return _error(str(ve))
    except Exception as e:
        if conn:
            conn.rollback()
        import traceback
        traceback.print_exc()
        return _error(str(e))
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# COMMUNITY ISSUE REPORTS
# ─────────────────────────────────────────────
@app.route("/api/reports/meta", methods=["GET"])
def reports_meta():
    """Issue-type / severity options — lets clients build the report form
    without hardcoding the list."""
    return jsonify({
        "issue_types": sorted(VALID_ISSUE_TYPES),
        "severities": sorted(VALID_SEVERITIES),
    })


@app.route("/api/report", methods=["POST"])
def submit_report():
    """
    Submit a new issue report at a location.

    Required fields:
        latitude / lat, longitude / lon   — floats
        issue_type                        — one of VALID_ISSUE_TYPES

    Optional fields:
        severity      — 'low' | 'medium' | 'high' (default 'medium')
        description   — string, max 500 chars
        session_id    — string
        device_type   — 'web' | 'mobile'
    """
    data = request.get_json(silent=True)
    if not data:
        return _error("Invalid JSON")

    try:
        lat = data.get("latitude", data.get("lat"))
        lon = data.get("longitude", data.get("lon"))
        if lat is None or lon is None:
            return _error("latitude/longitude are required")

        result = create_report(
            latitude=lat,
            longitude=lon,
            issue_type=data.get("issue_type"),
            severity=data.get("severity", "medium"),
            description=data.get("description"),
            session_id=data.get("session_id"),
            device_type=data.get("device_type", "web"),
        )
        return jsonify({"status": "saved", **result})

    except ValueError as ve:
        return _error(str(ve))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return _error(str(e))


@app.route("/api/reports/route", methods=["POST"])
def reports_along_route():
    """Reports within 120m of a route polyline — same shape as the
    crime/deadends/roadquality overlay endpoints below."""
    try:
        body = request.get_json(silent=True) or {}
        coords = body.get("coords", [])
        issue_types = body.get("issue_types")  # optional filter list
        return jsonify({"reports": reports_near_coords(coords, issue_types=issue_types)})
    except Exception as e:
        print("[REPORTS ROUTE ERROR]", e)
        return jsonify({"reports": []}), 500


@app.route("/api/reports/nearby", methods=["GET"])
def reports_nearby_point():
    """Reports near a single point — for browsing the map without a route."""
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
        radius_m = float(request.args.get("radius_m", 500))
        types_raw = request.args.get("issue_types", "")
        issue_types = [t.strip() for t in types_raw.split(",") if t.strip()] or None
        return jsonify({
            "reports": reports_nearby(lat, lon, radius_m=radius_m, issue_types=issue_types)
        })
    except (KeyError, ValueError):
        return _error("lat and lon query params are required")
    except Exception as e:
        print("[REPORTS NEARBY ERROR]", e)
        return jsonify({"reports": []}), 500


# ─────────────────────────────────────────────
# LIVE NEWS-SOURCED CRIME FEED
# ─────────────────────────────────────────────
@app.route("/api/news/refresh", methods=["POST"])
def news_refresh():
    """
    Manually trigger one fetch → geocode → classify → ingest cycle.
    Also runs automatically on a timer if NEWS_API_KEY is set — see
    news_ingest.start_news_scheduler(). Safe to call repeatedly; existing
    articles are skipped via a unique constraint on article_url.
    """
    result = run_news_ingestion()
    status_code = 200 if not result.get("error") else 502
    return jsonify(result), status_code


@app.route("/api/news/backfill", methods=["POST"])
def news_backfill():
    """
    One-off backfill of the past month, ~1 NewsAPI request per day
    (well inside the 100/day free-plan budget) instead of one wide-range
    request — this plan blocks pagination past page 1, so a single call
    would still only return the newest ~100 matches. Optional JSON body:
    {"days": 30} to backfill fewer days.
    """
    days = int((request.get_json(silent=True) or {}).get("days", 30))
    result = backfill_past_month(days=days)
    status_code = 200 if not result.get("error") else 502
    return jsonify(result), status_code


@app.route("/api/news/status", methods=["GET"])
def news_status():
    """Last-refresh stats — powers the 'live crime feed' badge in the UI,
    directly answering the 'crime data is static' feedback."""
    return jsonify(ingestion_status())


@app.route("/api/news/recent", methods=["GET"])
def news_recent():
    try:
        limit = int(request.args.get("limit", 50))
        area = request.args.get("area")
        return jsonify({"articles": recent_news(limit=limit, area=area)})
    except Exception as e:
        print("[NEWS RECENT ERROR]", e)
        return jsonify({"articles": []}), 500


@app.route("/api/news/route", methods=["POST"])
def news_along_route():
    """News-sourced crime items within 200m of a route — same shape as
    the other /route overlay endpoints."""
    try:
        body = request.get_json(silent=True) or {}
        coords = body.get("coords", [])
        return jsonify({"articles": news_near_coords(coords)})
    except Exception as e:
        print("[NEWS ROUTE ERROR]", e)
        return jsonify({"articles": []}), 500


# ─────────────────────────────────────────────
# OVERLAYS
# ─────────────────────────────────────────────
@app.route("/api/crime/route", methods=["POST"])
def crime_along_route():
    conn = None
    cur  = None
    try:
        coords = (request.json or {}).get("coords", [])
        if not coords:
            return jsonify({"points": []})

        linestring = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in coords) + ")"

        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            WITH route AS (SELECT ST_GeomFromText(%s, 4326) AS geom),
            filtered AS (
                SELECT r.geom
                FROM osm_roads r
                INNER JOIN crime_road_link crl ON r.id = crl.road_id,
                     route rt
                WHERE ST_DWithin(r.geom::geography, rt.geom::geography, 120)
            ),
            clusters AS (
                SELECT ST_Centroid(ST_Collect(geom)) AS geom
                FROM filtered
                GROUP BY ST_SnapToGrid(geom, 0.002)
            )
            SELECT ST_Y(geom) AS lat, ST_X(geom) AS lon
            FROM clusters LIMIT 150
        """, (linestring,))
        return jsonify({"points": [{"lat": float(r[0]), "lon": float(r[1])} for r in cur.fetchall()]})
    except Exception as e:
        print("[CRIME ROUTE ERROR]", e)
        return jsonify({"points": []}), 500
    finally:
        if cur:  cur.close()
        if conn: release_conn(conn)


@app.route("/api/deadends/route", methods=["POST"])
def deadends_along_route():
    conn = None
    cur  = None
    try:
        coords = (request.json or {}).get("coords", [])
        if not coords:
            return jsonify({"points": []})

        linestring = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in coords) + ")"

        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            WITH route AS (SELECT ST_GeomFromText(%s, 4326) AS geom),
            dead_end_nodes AS (
                SELECT target AS node_id
                FROM osm_roads GROUP BY target HAVING COUNT(*) = 1
            )
            SELECT ST_Y(v.the_geom) AS lat, ST_X(v.the_geom) AS lon
            FROM osm_roads_vertices_pgr v
            INNER JOIN dead_end_nodes de ON v.id = de.node_id,
                   route rt
            WHERE ST_DWithin(v.the_geom::geography, rt.geom::geography, 120)
            LIMIT 100
        """, (linestring,))
        return jsonify({"points": [{"lat": float(r[0]), "lon": float(r[1])} for r in cur.fetchall()]})
    except Exception as e:
        print("[DEADENDS ROUTE ERROR]", e)
        return jsonify({"points": []}), 500
    finally:
        if cur:  cur.close()
        if conn: release_conn(conn)


@app.route("/api/roadquality/route", methods=["POST"])
def roadquality_along_route():
    conn = None
    cur  = None
    try:
        coords = (request.json or {}).get("coords", [])
        if not coords:
            return jsonify({"segments": []})

        linestring = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in coords) + ")"

        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            WITH route AS (SELECT ST_GeomFromText(%s, 4326) AS geom)
            SELECT
                COALESCE(r.highway, 'unclassified') AS highway,
                ST_AsGeoJSON(r.geom)                AS geometry
            FROM osm_roads r, route rt
            WHERE ST_DWithin(r.geom::geography, rt.geom::geography, 25)
            ORDER BY r.highway NULLS LAST
            LIMIT 400
        """, (linestring,))
        return jsonify({"segments": [{"highway": r[0], "geometry": r[1]} for r in cur.fetchall()]})
    except Exception as e:
        print("[ROADQUALITY ROUTE ERROR]", e)
        return jsonify({"segments": []}), 500
    finally:
        if cur:  cur.close()
        if conn: release_conn(conn)


# ─────────────────────────────────────────────
# DEBUG / HEALTH
# ─────────────────────────────────────────────
# ─────────────────────────────────────────────
# QUERY CACHE ADMIN
# ─────────────────────────────────────────────
# ─────────────────────────────────────────────
# AI — predictive satisfaction model (ml_model.py)
# ─────────────────────────────────────────────
@app.route("/api/ai/model-status", methods=["GET"])
def ai_model_status():
    """Whether the model is trained, on how many samples, and which
    features it found most predictive — good for a demo: shows this is a
    real fitted model, not a black box."""
    return jsonify(ml_model.get_model_status())


@app.route("/api/ai/retrain", methods=["POST"])
def ai_retrain():
    """Manually trigger a retrain from the current user_feedback table.
    Normally not needed — new feedback already triggers this
    automatically in the background."""
    result = ml_model.train_satisfaction_model()
    status_code = 200 if result.get("trained") else 202  # 202: accepted, not yet actionable
    return jsonify(result), status_code


@app.route("/api/ai/predict", methods=["POST"])
def ai_predict():
    """
    Standalone prediction endpoint, for anything that wants an AI rating
    without going through /api/route/multi (e.g. the frontend re-checking
    a single mode after a weight tweak).

    Body: { route_length_km, trip_duration_min, route_option, hour? }
    """
    body = request.get_json(silent=True) or {}
    predicted = ml_model.predict_satisfaction(
        route_length=body.get("route_length_km"),
        trip_duration=body.get("trip_duration_min"),
        route_option=body.get("route_option", "safe"),
        hour=body.get("hour"),
    )
    if predicted is None:
        return jsonify({"predicted_rating": None, "available": False})
    return jsonify({"predicted_rating": predicted, "available": True})


@app.route("/api/ai/briefing", methods=["POST"])
def ai_briefing():
    """
    LLM-generated plain-English safety briefing for a route, grounded in
    its actual computed scores plus live nearby community reports/news.
    Gated behind ANTHROPIC_API_KEY — returns {"available": false, ...}
    rather than erroring if unset, same pattern as the news feature.

    Body: {
      route: { distance_km, eta_min, safety_score },  // from /api/route/multi
      route_coords: [[lat, lon], ...],                 // optional, enables
                                                          //   nearby report/news lookup
      hour: 22,
      mode: "safe"
    }
    """
    body = request.get_json(silent=True) or {}
    result = generate_route_briefing(
        route_summary=body.get("route") or {},
        route_coords=body.get("route_coords"),
        hour=body.get("hour"),
        mode=body.get("mode", "safe"),
    )
    status_code = 200 if result.get("available") else 503
    return jsonify(result), status_code


@app.route("/api/cache/status", methods=["GET"])
def cache_status():
    """Row counts for each materialized view — quick sanity check that
    the cache actually has data and isn't silently empty."""
    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute("""
            SELECT
                (SELECT COUNT(*) FROM mv_dead_end_nodes) AS dead_end_nodes,
                (SELECT COUNT(*) FROM mv_crime_agg)      AS crime_agg,
                (SELECT COUNT(*) FROM mv_report_agg)     AS report_agg,
                (SELECT COUNT(*) FROM mv_news_agg)       AS news_agg
        """)
        return jsonify(dict(cur.fetchone()))
    except Exception as e:
        return _error(str(e))
    finally:
        release_conn(conn)


@app.route("/api/cache/refresh", methods=["POST"])
def cache_refresh_dynamic():
    """Manually refresh the live views (mv_report_agg / mv_news_agg).
    Normally not needed — writes already trigger this — useful for
    demos/debugging."""
    ok = refresh_dynamic_views()
    return jsonify({"refreshed": ok})


@app.route("/api/cache/refresh-static", methods=["POST"])
def cache_refresh_static_route():
    """Manually refresh mv_dead_end_nodes / mv_crime_agg. Call this after
    reloading the OSM road network or historical crime dataset — they
    don't auto-refresh since they don't change at runtime otherwise."""
    ok = refresh_static_views()
    return jsonify({"refreshed": ok})


@app.route("/api/cache/rebuild-definitions", methods=["POST"])
def cache_rebuild_definitions():
    """Regenerates mv_report_agg / mv_news_agg FROM cost_engine.py's
    current constants (not the migration's hardcoded copy). Call this
    once after changing REPORT_HALF_LIFE_S / NEWS_HALF_LIFE_S / severity
    weights in cost_engine.py, so the cache can't silently drift out of
    sync with the code."""
    ok = rebuild_dynamic_view_definitions()
    return jsonify({"rebuilt": ok})


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/debug/route", methods=["GET"])
def debug_route():
    from cost_engine import build_cost_sql
    try:
        src_lat = float(request.args["src_lat"])
        src_lon = float(request.args["src_lon"])
        dst_lat = float(request.args["dst_lat"])
        dst_lon = float(request.args["dst_lon"])
    except (KeyError, ValueError):
        return _error("Invalid coordinates")

    conn = None
    try:
        conn = get_conn()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cost_sql = build_cost_sql(0.4, 0.3, 0.3)
        cur.execute(f"""
            SELECT COUNT(*) AS n FROM ({cost_sql}) AS e WHERE e.cost > 0
        """)
        return jsonify({"valid_edges": cur.fetchone()["n"]})
    except Exception as e:
        return _error(str(e))
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# RUN
# ─────────────────────────────────────────────
# Start the background news-refresh scheduler once, at import time — this
# way it also starts correctly under gunicorn/production, not just
# `python app.py`. (The reloader is turned off below specifically so this
# only ever runs in a single process during dev too — see start_news_scheduler()
# for the NEWS_API_KEY-gated, idempotent guard.)
start_news_scheduler()

# Query-cache scheduler (cache_refresh.py) — periodic REFRESH CONCURRENTLY
# for mv_report_agg / mv_news_agg, catching pure recency-decay drift
# between writes. New reports/news already trigger an immediate refresh
# on insert; this just keeps things fresh during quiet periods too.
start_cache_refresh_scheduler(interval_min=int(os.getenv("CACHE_REFRESH_INTERVAL_MIN", 5)))

if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5001))
    print(f"\nSafeRoute running at http://localhost:{port}\n")
    app.run(debug=True, use_reloader=False, host="0.0.0.0", port=port)