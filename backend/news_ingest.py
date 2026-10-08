# news_ingest.py
#
# Fetches recent crime-related news (via NewsAPI.org), matches each
# article to a known locality from south_crime_raw.area (so location
# comes from data you already trust rather than a hardcoded gazetteer),
# classifies the crime type/severity from the headline+description, snaps
# it to the nearest road edge, and stores it in news_crime_reports.
#
# This is what turns "crime data is static" into a data source that
# refreshes itself — see start_news_scheduler() for the background loop,
# and the news_raw/news_agg CTEs in cost_engine.py for how it's folded
# into routing with a short recency-decay window.

import os
import re
import time
import json
import threading
from datetime import date, timedelta

import requests

from db import get_conn, release_conn, dict_cur
from cache_refresh import refresh_dynamic_views
from reports import _snap_nearest_road  # reuse the same nearest-road snap

NEWSAPI_URL = "https://newsapi.org/v2/everything"

# ─────────────────────────────────────────────
# NewsAPI Developer (free) plan limits — see
# https://newsapi.org/pricing:
#   - 100 requests/day, no burst/overage allowed
#   - articles up to ~1 month old, ~24h publish delay
#   - CORS enabled for localhost only (irrelevant here — this file calls
#     NewsAPI server-side with `requests`, never from browser JS, so the
#     API key is never exposed to the frontend regardless of that CORS rule)
# ─────────────────────────────────────────────
DAILY_REQUEST_BUDGET = int(os.environ.get("NEWS_API_DAILY_BUDGET", "100"))
_BUDGET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".news_api_usage.json")
_budget_lock = threading.Lock()


def _load_budget_state():
    try:
        with open(_BUDGET_FILE, "r") as f:
            state = json.load(f)
        if state.get("date") == date.today().isoformat():
            return state
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
        pass
    return {"date": date.today().isoformat(), "count": 0}


def _save_budget_state(state):
    try:
        with open(_BUDGET_FILE, "w") as f:
            json.dump(state, f)
    except OSError as e:
        print(f"[NEWS] warning: could not persist API budget state: {e}")


def _consume_budget_slot():
    """
    Reserve one call against today's NewsAPI request budget, persisted to
    disk (not memory) — the dev server gets restarted often, and an
    in-memory counter would forget every call made before the last
    restart, silently blowing past the plan's 100/day cap. Raises if
    today's budget is already spent, so a caller can skip the fetch
    instead of getting a hard 429 from NewsAPI itself.
    """
    with _budget_lock:
        state = _load_budget_state()
        if state["count"] >= DAILY_REQUEST_BUDGET:
            raise RuntimeError(
                f"NewsAPI daily request budget ({DAILY_REQUEST_BUDGET}) already used "
                f"today ({state['date']}) — skipping fetch until it resets."
            )
        state["count"] += 1
        _save_budget_state(state)
        return state["count"]


def remaining_daily_budget():
    """How many NewsAPI calls are left today — for status/debug panels."""
    state = _load_budget_state()
    return max(0, DAILY_REQUEST_BUDGET - state["count"])


# Only fetch articles that are plausibly Bengaluru + crime related.
NEWS_QUERY = (
    '(bengaluru OR bangalore) AND '
    '(crime OR theft OR robbery OR robbed OR murder OR stabbed OR assault '
    'OR molestation OR "chain snatching" OR burglary OR kidnap OR mugging)'
)

# Keyword -> (crime_type, severity). Checked in order; first match wins,
# so more specific/severe terms are listed first.
CRIME_KEYWORD_RULES = [
    (r"\bmurder(ed)?\b|\bhomicide\b|\bkilled\b|\bstabbed to death\b", "murder", "high"),
    (r"\brape[d]?\b|\bmolest(ed|ation)?\b|\bsexual assault\b", "molestation", "high"),
    (r"\bstab(bed|bing)?\b|\bknife attack\b", "assault", "high"),
    (r"\bkidnap(ped|ping)?\b|\babduct(ed|ion)?\b", "kidnapping", "high"),
    (r"\brobb(ed|ery)\b|\bloot(ed)?\b|\bheld at gunpoint\b|\bheld at knifepoint\b", "robbery", "medium"),
    (r"\bchain snatch(ed|ing)?\b|\bsnatch(ed|ing)?\b", "chain_snatching", "medium"),
    (r"\bassault(ed)?\b|\battacked\b|\bbeaten\b|\bthrashed\b", "assault", "medium"),
    (r"\bburglar(y|ised|ized)\b|\bhouse break-?in\b", "burglary", "medium"),
    (r"\btheft\b|\bstolen\b|\bstole\b|\bpickpocket(ed|ing)?\b", "theft", "low"),
    (r"\bharass(ed|ment)?\b|\beve.?teas(ed|ing)\b|\bstalk(ed|ing)?\b", "harassment", "low"),
]

# Belt-and-suspenders city guard. NewsAPI's /v2/everything does not
# reliably honor long nested boolean queries (AND between a parenthesized
# city group and a parenthesized crime-keyword group) — in practice it can
# fall back to a much looser match and return completely unrelated
# articles (other states, entertainment, etc.). NEWS_QUERY narrows what we
# *ask* for; this pattern narrows what we're willing to *accept* back.
BENGALURU_PATTERN = re.compile(r"\b(bengaluru|bangalore|bengaluru city)\b", re.IGNORECASE)

MIN_AREA_NAME_LEN = 6      # avoid false-positive matches on very short area names
AREA_CACHE_TTL_S = 3600    # rebuild the known-areas cache at most hourly

_area_cache = {"areas": [], "built_at": 0}
_area_cache_lock = threading.Lock()


# ─────────────────────────────────────────────
# KNOWN AREAS  (from south_crime_raw, not hardcoded)
# ─────────────────────────────────────────────
def _load_known_areas(cur):
    """
    Areas already present in the historical crime dataset, each with a
    centroid derived from its own incident coordinates. Longer names are
    sorted first so a more specific match ("HSR Layout Sector 2") wins
    over a shorter substring ("HSR Layout") when both appear in an article.
    """
    cur.execute(
        """
        SELECT area,
               AVG(latitude)  AS lat,
               AVG(longitude) AS lon,
               COUNT(*)       AS n
        FROM south_crime_raw
        WHERE area IS NOT NULL AND length(trim(area)) >= %s
        GROUP BY area
        """,
        (MIN_AREA_NAME_LEN,),
    )
    rows = cur.fetchall()
    areas = [
        {"name": r["area"].strip(), "lat": r["lat"], "lon": r["lon"], "n": r["n"]}
        for r in rows
        if r["lat"] is not None and r["lon"] is not None
    ]
    areas.sort(key=lambda a: len(a["name"]), reverse=True)
    return areas


def _get_known_areas(cur, force=False):
    with _area_cache_lock:
        stale = (time.time() - _area_cache["built_at"]) > AREA_CACHE_TTL_S
        if force or stale or not _area_cache["areas"]:
            _area_cache["areas"] = _load_known_areas(cur)
            _area_cache["built_at"] = time.time()
        return _area_cache["areas"]


def _match_area(text, areas):
    """First (longest) area name that appears as a whole word/phrase in `text`."""
    lowered = text.lower()
    for area in areas:
        name = area["name"].lower()
        if re.search(r"\b" + re.escape(name) + r"\b", lowered):
            return area
    return None


# ─────────────────────────────────────────────
# CRIME CLASSIFICATION
# ─────────────────────────────────────────────
def _classify(text):
    lowered = text.lower()
    for pattern, crime_type, severity in CRIME_KEYWORD_RULES:
        if re.search(pattern, lowered):
            return crime_type, severity
    return "other", "low"


# ─────────────────────────────────────────────
# NEWSAPI FETCH
# ─────────────────────────────────────────────
# NOTE ON PLAN LIMITS: NewsAPI's free/Developer tier only searches
# articles from roughly the last month and caps /v2/everything to a
# single page (~100 results) — page 2+ and any older `from` date both
# get rejected outright with a 426, not clamped. So on this plan there's
# nothing to gain from requesting more than one page: just ask for the
# most recent 100 and let the plan's own lookback floor apply.
def _fetch_articles(api_key, page_size=100, from_date=None, to_date=None):
    if not api_key:
        raise RuntimeError("NEWS_API_KEY is not set")

    _consume_budget_slot()  # raises if today's 100-request budget is used up

    params = {
        "q": NEWS_QUERY,
        "language": "en",
        "sortBy": "publishedAt",
        "pageSize": page_size,
    }
    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date

    resp = requests.get(NEWSAPI_URL, params=params, headers={"X-Api-Key": api_key}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "ok":
        raise RuntimeError(f"NewsAPI error: {data.get('message', 'unknown error')}")
    return data.get("articles", [])


def _ingest_articles(cur, areas, articles, summary):
    """Shared classify/filter/geocode/insert step used by both the normal
    single-fetch cycle and the day-by-day backfill."""
    for art in articles:
        url = art.get("url")
        title = art.get("title") or ""
        desc = art.get("description") or ""
        source_name = (art.get("source") or {}).get("name")
        published_at = art.get("publishedAt")

        if not url or not title:
            continue

        full_text = f"{title}. {desc}"
        area = _match_area(full_text, areas)
        crime_type, severity = _classify(full_text)

        # Reject anything NewsAPI returned that isn't actually about
        # Bengaluru AND actually about crime, no matter what the API's
        # own query matching decided.
        #
        # IMPORTANT: a known-area match is NOT proof of Bengaluru by
        # itself. south_crime_raw's area names are generic Indian
        # locality naming patterns ("Gandhi Nagar", "Shivaji Nagar",
        # "Indira Nagar", etc.) that exist in dozens of Indian cities.
        # A Jalgaon or Palamu article can innocently mention a
        # same-named locality and false-positive-match an area row
        # that actually refers to a Bengaluru neighborhood. So the
        # city check must always require the literal city name; area
        # matching is only used afterwards, for geocoding.
        is_bengaluru = bool(BENGALURU_PATTERN.search(full_text))
        is_crime = crime_type != "other"
        if not (is_bengaluru and is_crime):
            summary["rejected"] += 1
            continue

        road_id, distance_m, lat, lon = None, None, None, None
        if area:
            lat, lon = area["lat"], area["lon"]
            road_id, distance_m = _snap_nearest_road(cur, lon, lat)

        cur.execute(
            """
            INSERT INTO news_crime_reports (
                article_url, headline, source_name, published_at,
                area_name, latitude, longitude, geom,
                crime_type, severity, road_id, distance_m
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s,
                CASE WHEN %s IS NOT NULL AND %s IS NOT NULL
                     THEN ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                     ELSE NULL END,
                %s, %s, %s, %s
            )
            ON CONFLICT (article_url) DO NOTHING
            RETURNING id
            """,
            (
                url, title[:500], source_name, published_at,
                area["name"] if area else None, lat, lon,
                lon, lat, lon, lat,
                crime_type, severity, road_id, distance_m,
            ),
        )
        row = cur.fetchone()
        if row is None:
            # ON CONFLICT DO NOTHING with RETURNING gives no row when
            # it was a duplicate; but it could also mean article_url
            # collided. Either way, count as duplicate/skip.
            summary["duplicate"] += 1
        else:
            summary["inserted"] += 1
            if area is None:
                summary["unmatched"] += 1


# ─────────────────────────────────────────────
# INGEST ONE CYCLE
# ─────────────────────────────────────────────
def run_news_ingestion(api_key=None):
    """
    Fetch → dedupe → geocode-by-area → classify → snap-to-road → insert.
    Returns a summary dict. Safe to call repeatedly (existing article_urls
    are skipped via ON CONFLICT DO NOTHING).
    """
    api_key = api_key or os.environ.get("NEWS_API_KEY")
    summary = {"fetched": 0, "inserted": 0, "duplicate": 0, "unmatched": 0, "rejected": 0, "error": None}

    if not api_key:
        summary["error"] = "NEWS_API_KEY not set"
        return summary

    try:
        articles = _fetch_articles(api_key)
    except Exception as e:
        summary["error"] = str(e)
        return summary

    summary["fetched"] = len(articles)
    if not articles:
        return summary

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        areas = _get_known_areas(cur)
        _ingest_articles(cur, areas, articles, summary)
        conn.commit()
        cur.close()

    except Exception as e:
        if conn:
            conn.rollback()
        summary["error"] = str(e)
    finally:
        release_conn(conn)

    if summary["inserted"] > 0:
        refresh_dynamic_views()

    return summary


# ─────────────────────────────────────────────
# BACKFILL — past month, one day at a time
# ─────────────────────────────────────────────
def backfill_past_month(api_key=None, days=30, pause_s=0.5):
    """
    One-off backfill of up to `days` days of history, ~1 NewsAPI request
    per day (well inside the 100/day budget). Split by day rather than
    requested as one range because this plan blocks pagination past page
    1 — a single wide-range request still only returns the newest ~100
    matches, which on a busy query can be just a few days' worth. Scoping
    `from`/`to` to one calendar day per call sidesteps that, since each
    day is its own fresh page-1 request.

    Stops early (without erroring) if the daily request budget runs out
    or NewsAPI's own month-old floor rejects a date — whatever was
    fetched before that point is still committed.
    """
    api_key = api_key or os.environ.get("NEWS_API_KEY")
    summary = {
        "days_requested": days, "days_completed": 0,
        "fetched": 0, "inserted": 0, "duplicate": 0, "unmatched": 0, "rejected": 0,
        "stopped_early": None, "error": None,
    }

    if not api_key:
        summary["error"] = "NEWS_API_KEY not set"
        return summary

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        areas = _get_known_areas(cur)

        today = date.today()
        for offset in range(days):
            day = today - timedelta(days=offset)
            from_date = day.isoformat()
            to_date = (day + timedelta(days=1)).isoformat()

            try:
                articles = _fetch_articles(api_key, from_date=from_date, to_date=to_date)
            except Exception as e:
                # Budget exhausted or plan's lookback floor hit — stop the
                # loop cleanly rather than losing everything gathered so far.
                summary["stopped_early"] = f"{from_date}: {e}"
                break

            summary["fetched"] += len(articles)
            _ingest_articles(cur, areas, articles, summary)
            conn.commit()  # commit per day, so a later failure doesn't roll back earlier days
            summary["days_completed"] += 1
            time.sleep(pause_s)  # be polite to the API rather than hammering it in a tight loop

        cur.close()

    except Exception as e:
        summary["error"] = str(e)
    finally:
        release_conn(conn)

    if summary["inserted"] > 0:
        refresh_dynamic_views()

    return summary


# ─────────────────────────────────────────────
# READ — for the web overlay / status panel
# ─────────────────────────────────────────────
def recent_news(limit=50, area=None):
    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        if area:
            cur.execute(
                """
                SELECT id, headline, source_name, article_url, published_at,
                       area_name, latitude, longitude, crime_type, severity
                FROM news_crime_reports
                WHERE status = 'active' AND area_name = %s
                ORDER BY published_at DESC NULLS LAST
                LIMIT %s
                """,
                (area, limit),
            )
        else:
            cur.execute(
                """
                SELECT id, headline, source_name, article_url, published_at,
                       area_name, latitude, longitude, crime_type, severity
                FROM news_crime_reports
                WHERE status = 'active'
                ORDER BY published_at DESC NULLS LAST
                LIMIT %s
                """,
                (limit,),
            )
        rows = cur.fetchall()
        cur.close()
        return [
            {
                "id": r["id"],
                "headline": r["headline"],
                "source": r["source_name"],
                "url": r["article_url"],
                "published_at": r["published_at"].isoformat() if r["published_at"] else None,
                "area": r["area_name"],
                "lat": r["latitude"],
                "lon": r["longitude"],
                "crime_type": r["crime_type"],
                "severity": r["severity"],
            }
            for r in rows
        ]
    finally:
        release_conn(conn)


def news_near_coords(coords, radius_m=200, limit=200):
    if not coords:
        return []
    linestring = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in coords) + ")"
    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute(
            """
            WITH route AS (SELECT ST_GeomFromText(%s, 4326) AS geom)
            SELECT n.id, n.headline, n.source_name, n.article_url, n.published_at,
                   n.area_name, n.latitude, n.longitude, n.crime_type, n.severity
            FROM news_crime_reports n, route rt
            WHERE n.status = 'active'
              AND n.geom IS NOT NULL
              AND ST_DWithin(n.geom, rt.geom::geography, %s)
            ORDER BY n.published_at DESC NULLS LAST
            LIMIT %s
            """,
            (linestring, radius_m, limit),
        )
        rows = cur.fetchall()
        cur.close()
        return [
            {
                "id": r["id"], "headline": r["headline"], "source": r["source_name"],
                "url": r["article_url"],
                "published_at": r["published_at"].isoformat() if r["published_at"] else None,
                "area": r["area_name"], "lat": r["latitude"], "lon": r["longitude"],
                "crime_type": r["crime_type"], "severity": r["severity"],
            }
            for r in rows
        ]
    finally:
        release_conn(conn)


def ingestion_status():
    """Last-run stats for a 'live feed' badge in the UI / panel demo."""
    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute(
            """
            SELECT COUNT(*) AS total,
                   MAX(fetched_at) AS last_fetched,
                   COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '24 hours') AS last_24h
            FROM news_crime_reports
            """
        )
        row = cur.fetchone()
        cur.close()
        return {
            "total_articles": row["total"] or 0,
            "last_fetched_at": row["last_fetched"].isoformat() if row["last_fetched"] else None,
            "articles_last_24h": row["last_24h"] or 0,
            "auto_refresh_enabled": bool(os.environ.get("NEWS_API_KEY")),
            "daily_requests_remaining": remaining_daily_budget(),
        }
    finally:
        release_conn(conn)


# ─────────────────────────────────────────────
# BACKGROUND SCHEDULER
# ─────────────────────────────────────────────
_scheduler_started = False


def _refresh_loop(interval_s):
    while True:
        try:
            result = run_news_ingestion()
            print(f"[NEWS] ingestion cycle: {result}")
        except Exception as e:
            print(f"[NEWS] ingestion cycle failed: {e}")
        time.sleep(interval_s)


def start_news_scheduler():
    """
    Starts a daemon thread that re-runs ingestion on a timer. No-op if
    NEWS_API_KEY isn't set, so the app still starts cleanly without it
    (mirrors the Learning Module's graceful-degrade-to-defaults pattern).
    Idempotent — safe to call more than once.
    """
    global _scheduler_started
    if _scheduler_started:
        return

    api_key = os.environ.get("NEWS_API_KEY")
    if not api_key:
        print("[NEWS] NEWS_API_KEY not set — auto-refresh disabled (endpoints still work manually)")
        return

    interval_min = int(os.environ.get("NEWS_REFRESH_INTERVAL_MIN", "180"))
    t = threading.Thread(target=_refresh_loop, args=(interval_min * 60,), daemon=True)
    t.start()
    _scheduler_started = True
    print(f"[NEWS] auto-refresh scheduler started — every {interval_min} min")