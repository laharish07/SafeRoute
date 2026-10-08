# learning.py (FIXED)

import logging
import math
import time
from dataclasses import dataclass
from typing import Optional

from db import get_conn, dict_cur, release_conn

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# CONSTANTS
# ──────────────────────────────────────────────
MIN_SAMPLES = 5
MIN_OPTION_SAMPLES = 8
FULL_CONFIDENCE_AT = 30

RECENCY_HALF_LIFE_S = 30 * 86400
IQR_FENCE = 1.5

MIN_RATING_DURATION = 3
FAST_SUBMIT_PENALTY = 0.2

SIGMOID_CENTER = 3.0
SIGMOID_SCALE = 0.4
SIGMOID_BASE = 0.2

# Cache entries expire after this many seconds even without a feedback
# submission.  Prevents stale weights surviving restarts or external DB edits.
CACHE_TTL_S = 5 * 60   # 5 minutes

DEFAULTS = {
    "w_safety": 0.4,
    "w_road": 0.3,
    "w_deadend": 0.3,
    "source": "default",
    "based_on": 0,
    "confidence": 0.0,
    "time_of_day": None,
    "options": None,
}


@dataclass
class _CacheEntry:
    result: dict
    stored_at: float   # time.monotonic() timestamp


_cache: dict[tuple, _CacheEntry] = {}

# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────

def _rating_to_weight(r: float) -> float:
    return round(SIGMOID_BASE + SIGMOID_SCALE / (1 + math.exp(r - SIGMOID_CENTER)), 4)


def _blend(learned, default, confidence):
    return confidence * learned + (1 - confidence) * default


def _consistency(std):
    if std is None:
        return 0.5
    return round(max(0.0, 1.0 - float(std) / 2.0), 3)


# ──────────────────────────────────────────────
# FIXED SQL (NO AMBIGUITY, NO BAD JOIN)
# ──────────────────────────────────────────────

_LEARN_SQL = """
WITH raw AS (
    SELECT
        safety_rating,
        road_rating,
        deadend_rating,
        COALESCE(route_length, 1.0) AS route_len,
        COALESCE(rating_duration_s, 10) AS rate_secs,
        EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / %(half_life_s)s) AS recency_w
    FROM user_feedback
    WHERE safety_rating IS NOT NULL
      AND road_rating IS NOT NULL
      AND deadend_rating IS NOT NULL
      AND flagged IS NOT TRUE
      {time_filter}
      {opts_filter}
),

bounds AS (
    SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY safety_rating) AS s_q1,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY safety_rating) AS s_q3,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY road_rating) AS r_q1,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY road_rating) AS r_q3,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY deadend_rating) AS d_q1,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY deadend_rating) AS d_q3
    FROM raw
),

cleaned AS (
    SELECT
        r.safety_rating,
        r.road_rating,
        r.deadend_rating,
        r.route_len,
        r.recency_w
        * LN(1 + r.route_len / 1000.0)
        * CASE
            WHEN r.rate_secs < %(min_dur)s THEN %(fast_penalty)s
            ELSE 1.0
          END AS w
    FROM raw r CROSS JOIN bounds b
    WHERE r.safety_rating BETWEEN b.s_q1 - %(fence)s*(b.s_q3 - b.s_q1)
                              AND b.s_q3 + %(fence)s*(b.s_q3 - b.s_q1)
      AND r.road_rating BETWEEN b.r_q1 - %(fence)s*(b.r_q3 - b.r_q1)
                              AND b.r_q3 + %(fence)s*(b.r_q3 - b.r_q1)
      AND r.deadend_rating BETWEEN b.d_q1 - %(fence)s*(b.d_q3 - b.d_q1)
                              AND b.d_q3 + %(fence)s*(b.d_q3 - b.d_q1)
)

SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cleaned.safety_rating) AS s_med,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cleaned.road_rating) AS r_med,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cleaned.deadend_rating) AS d_med,

    STDDEV_POP(cleaned.safety_rating) AS s_std,
    STDDEV_POP(cleaned.road_rating) AS r_std,
    STDDEV_POP(cleaned.deadend_rating) AS d_std,

    COUNT(*) AS n_clean,
    SUM(w) AS total_w
FROM cleaned;
"""

# ──────────────────────────────────────────────
# QUERY EXECUTION
# ──────────────────────────────────────────────

def _run_query(time_of_day=None, options_key=None):
    time_filter = "AND time_of_day = %(tod)s" if time_of_day else ""
    opts_filter = "AND route_options = %(opts)s" if options_key else ""

    sql = _LEARN_SQL.format(time_filter=time_filter, opts_filter=opts_filter)

    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute(sql, {
            "half_life_s": RECENCY_HALF_LIFE_S,
            "fence": IQR_FENCE,
            "min_dur": MIN_RATING_DURATION,
            "fast_penalty": FAST_SUBMIT_PENALTY,
            "tod": time_of_day,
            "opts": options_key,
        })
        row = cur.fetchone()
        cur.close()
        return row
    except Exception:
        logger.exception("Learning query failed")
        return None
    finally:
        release_conn(conn)


# ──────────────────────────────────────────────
# WEIGHT COMPUTATION
# ──────────────────────────────────────────────

def _row_to_weights(row, time_of_day, options_key, min_samples):
    n = int(row["n_clean"] or 0)
    if n < min_samples:
        return None

    ws = _rating_to_weight(float(row["s_med"]))
    wr = _rating_to_weight(float(row["r_med"]))
    wd = _rating_to_weight(6 - float(row["d_med"]))  # FIXED

    confidence = min(1.0, n / FULL_CONFIDENCE_AT)

    ws = _blend(ws, DEFAULTS["w_safety"], confidence)
    wr = _blend(wr, DEFAULTS["w_road"], confidence)
    wd = _blend(wd, DEFAULTS["w_deadend"], confidence)

    total = ws + wr + wd
    ws, wr, wd = ws / total, wr / total, wd / total

    return {
        "w_safety": round(ws, 3),
        "w_road": round(wr, 3),
        "w_deadend": round(wd, 3),
        "source": "learned",
        "based_on": n,
        "confidence": round(confidence, 2),
        "time_of_day": time_of_day,
        "options": options_key,
    }


# ──────────────────────────────────────────────
# PUBLIC API
# ──────────────────────────────────────────────

def get_suggested_weights(time_of_day=None, options_key=None):
    cache_key = (time_of_day, options_key)

    # Return cached result only if it hasn't expired yet.
    entry = _cache.get(cache_key)
    if entry and (time.monotonic() - entry.stored_at) < CACHE_TTL_S:
        return entry.result

    attempts = []

    if options_key and time_of_day:
        attempts.append((time_of_day, options_key, MIN_OPTION_SAMPLES))

    if options_key:
        attempts.append((None, options_key, MIN_OPTION_SAMPLES))

    if time_of_day:
        attempts.append((time_of_day, None, MIN_SAMPLES))

    attempts.append((None, None, MIN_SAMPLES))

    for tod, opts, min_n in attempts:
        row = _run_query(tod, opts)
        if not row:
            continue

        result = _row_to_weights(row, time_of_day, options_key, min_n)
        if result:
            _cache[cache_key] = _CacheEntry(result=result, stored_at=time.monotonic())
            return result

    # Fallback: return a stale cached entry (any age) rather than bare defaults,
    # so a brief DB hiccup doesn't discard hard-won learned weights entirely.
    if entry:
        logger.warning("Cache TTL expired and DB query failed; serving stale weights for %s", cache_key)
        return entry.result

    return {**DEFAULTS}


def get_weights_for_options(active_options, time_of_day=None):
    key = "+".join(sorted(active_options)) if active_options else "shortest"
    return get_suggested_weights(time_of_day, key)


def invalidate_cache():
    _cache.clear()