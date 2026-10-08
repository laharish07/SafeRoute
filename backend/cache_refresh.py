# cache_refresh.py
#
# Keeps the caching layer (see migrations/006_query_caching.sql) fresh.
#
# mv_dead_end_nodes / mv_crime_agg are static under the current design —
# they only need refreshing if the OSM road data or historical crime
# dataset is ever reloaded, so refresh_static_views() is a manual/admin
# action, not something on a timer.
#
# mv_report_agg / mv_news_agg are live — new reports/articles arrive
# continuously and their weight decays continuously with time — so
# refresh_dynamic_views() is called (a) right after every report/news
# insert for immediate freshness, and (b) on a periodic timer to catch
# the slow drift from pure time-decay even when nothing new comes in.
#
# rebuild_dynamic_view_definitions() is the escape hatch for when the
# decay half-life or severity weights in cost_engine.py change: rather
# than hand-editing the SQL in the migration to match, this regenerates
# both live view DEFINITIONS directly from cost_engine.py's own
# _report_category_case() / _report_severity_case() / _news_severity_case()
# helpers, so the cache can never silently drift out of sync with the
# Python source of truth. It's a DROP+CREATE (briefly exclusive-locks the
# view) so it's a deliberate one-off action, not part of normal refresh.

import threading
import time

from db import get_conn, release_conn
from cost_engine import (
    _report_category_case,
    _report_severity_case,
    _news_severity_case,
    REPORT_HALF_LIFE_S,
    NEWS_HALF_LIFE_S,
)


# ─────────────────────────────────────────────
# NORMAL REFRESH — fast, non-blocking, safe under concurrent routing load
# ─────────────────────────────────────────────
def refresh_dynamic_views():
    """
    REFRESH ... CONCURRENTLY requires a unique index (present on both
    views, see migration 006) but does NOT block concurrent SELECTs —
    routing requests keep reading the old snapshot until the refresh
    commits. Safe to call often; typically well under a second even with
    thousands of rows in user_reports/news_crime_reports.
    """
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_report_agg;")
        cur.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_news_agg;")
        conn.commit()
        cur.close()
        return True
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"[CACHE] refresh_dynamic_views failed: {e}")
        return False
    finally:
        release_conn(conn)


def refresh_static_views():
    """
    Call manually after reloading the OSM road network or the historical
    crime dataset — NOT on a timer, since neither changes at runtime.
    """
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dead_end_nodes;")
        cur.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_crime_agg;")
        conn.commit()
        cur.close()
        return True
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"[CACHE] refresh_static_views failed: {e}")
        return False
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# DEFINITION REBUILD — only when cost_engine.py's constants change
# ─────────────────────────────────────────────
def rebuild_dynamic_view_definitions():
    """
    Regenerates mv_report_agg / mv_news_agg FROM cost_engine.py's current
    constants (not from the migration file's hardcoded copy), so the two
    can never silently drift apart. Briefly exclusive-locks each view
    (DROP + CREATE, not REFRESH CONCURRENTLY) — call this deliberately
    after changing REPORT_HALF_LIFE_S / NEWS_HALF_LIFE_S / severity
    weights, not on a routine schedule.
    """
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()

        cur.execute(f"""
            DROP MATERIALIZED VIEW IF EXISTS mv_report_agg;
            CREATE MATERIALIZED VIEW mv_report_agg AS
            SELECT
                road_id,
                SUM(w) FILTER (WHERE category = 'road')    AS road_w,
                SUM(w) FILTER (WHERE category = 'safety')  AS safety_w,
                SUM(w) FILTER (WHERE category = 'deadend') AS deadend_w
            FROM (
                SELECT
                    road_id,
                    {_report_category_case()} AS category,
                    {_report_severity_case()}
                    * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - reported_at)) / {REPORT_HALF_LIFE_S}.0) AS w
                FROM user_reports
                WHERE road_id IS NOT NULL AND status IN ('pending', 'verified')
            ) report_raw
            GROUP BY road_id;
            CREATE UNIQUE INDEX idx_mv_report_agg ON mv_report_agg(road_id);
        """)

        cur.execute(f"""
            DROP MATERIALIZED VIEW IF EXISTS mv_news_agg;
            CREATE MATERIALIZED VIEW mv_news_agg AS
            SELECT road_id, SUM(w) AS news_w
            FROM (
                SELECT
                    road_id,
                    {_news_severity_case()}
                    * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - COALESCE(published_at, fetched_at))) / {NEWS_HALF_LIFE_S}.0) AS w
                FROM news_crime_reports
                WHERE road_id IS NOT NULL AND status = 'active'
            ) news_raw
            GROUP BY road_id;
            CREATE UNIQUE INDEX idx_mv_news_agg ON mv_news_agg(road_id);
        """)

        conn.commit()
        cur.close()
        return True
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"[CACHE] rebuild_dynamic_view_definitions failed: {e}")
        return False
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# BACKGROUND SCHEDULER — catches pure time-decay drift between writes
# ─────────────────────────────────────────────
_scheduler_started = False


def _refresh_loop(interval_s):
    while True:
        time.sleep(interval_s)
        refresh_dynamic_views()


def start_cache_refresh_scheduler(interval_min=5):
    """
    New reports/news already trigger an immediate refresh on insert (see
    reports.create_report and news_ingest.run_news_ingestion /
    backfill_past_month). This periodic timer exists only to keep the
    *decay* itself reasonably current during quiet periods where nothing
    new is being written but existing rows are still losing weight over
    time. Idempotent — safe to call more than once.
    """
    global _scheduler_started
    if _scheduler_started:
        return
    t = threading.Thread(target=_refresh_loop, args=(interval_min * 60,), daemon=True)
    t.start()
    _scheduler_started = True
    print(f"[CACHE] dynamic view refresh scheduler started — every {interval_min} min")
