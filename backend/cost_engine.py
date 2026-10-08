# cost_engine.py

HIGHWAY_PENALTY = {
    "motorway":     0.05,
    "trunk":        0.10,
    "primary":      0.15,
    "secondary":    0.20,
    "tertiary":     0.30,
    "unclassified": 0.50,
    "residential":  0.40,
    "service":      0.55,
    "living_street":0.45,
    "pedestrian":   0.35,
    "road":         0.50,
    "track":        0.65,
    "construction": 0.85,
}

DEFAULT_HIGHWAY_PENALTY = 0.50

# ✅ Balanced scaling (FIXED)
DISTANCE_SCALE = 8.0


# ─────────────────────────────────────────────
# COMMUNITY REPORT SCORING (user_reports)
# ─────────────────────────────────────────────
# Each pending/verified report contributes a weight of
#   severity_multiplier * 0.5 ^ (age_seconds / half_life_seconds)
# so a fresh "high" severity report matters a lot, and old reports fade
# out smoothly rather than dropping off a cliff. Per-road totals are
# normalised against the network-wide max, then blended additively (capped)
# into the same safety / road / deadend scores the cost model already uses —
# so a single w_safety / w_road / w_deadend weight from the caller still
# controls how much they matter, exactly like the historical crime data.

REPORT_HALF_LIFE_S = 14 * 86400   # reports "decay" over ~2 weeks

REPORT_SEVERITY_WEIGHT = {
    "low": 1.0,
    "medium": 2.0,
    "high": 3.5,
}

# issue_type -> which cost component it feeds
REPORT_CATEGORY = {
    "pothole": "road",
    "road_condition": "road",
    "flooding": "road",
    "lighting": "safety",
    "crime": "safety",
    "dead_end": "deadend",
    "obstruction": "deadend",
    "other": "road",
}

# Max additive boost a road's score can receive from community reports.
REPORT_BLEND_CAP = 0.5


def _report_category_case() -> str:
    cases = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in REPORT_CATEGORY.items())
    return f"CASE issue_type {cases} ELSE 'road' END"


def _report_severity_case() -> str:
    cases = " ".join(f"WHEN '{k}' THEN {v}" for k, v in REPORT_SEVERITY_WEIGHT.items())
    return f"CASE severity {cases} ELSE 1.0 END"


# ─────────────────────────────────────────────
# NEWS-SOURCED CRIME SCORING (news_crime_reports)
# ─────────────────────────────────────────────
# Same recency-decay idea as community reports, but with a much shorter
# half-life — a news article about an incident is a strong safety signal
# for the next few days and fades out fast, unlike a pothole. This is
# what keeps the "crime risk" component from being purely the static
# historical dataset: see news_ingest.py for how articles get in here.

NEWS_HALF_LIFE_S = 5 * 86400   # news signal decays over ~5 days

NEWS_SEVERITY_WEIGHT = {
    "low": 1.0,
    "medium": 2.5,
    "high": 4.0,
}

NEWS_BLEND_CAP = 0.4   # additive cap into safety_score, on top of REPORT_BLEND_CAP


def _news_severity_case() -> str:
    cases = " ".join(f"WHEN '{k}' THEN {v}" for k, v in NEWS_SEVERITY_WEIGHT.items())
    return f"CASE severity {cases} ELSE 1.0 END"


# ─────────────────────────────────────────────
# ROAD TYPE PENALTY CASE
# ─────────────────────────────────────────────
def _highway_case() -> str:
    cases = " ".join(
        f"WHEN r.highway = '{k}' THEN {v}"
        for k, v in HIGHWAY_PENALTY.items()
    )
    return f"CASE {cases} ELSE {DEFAULT_HIGHWAY_PENALTY} END"


# ─────────────────────────────────────────────
# MAIN COST SQL BUILDER
# ─────────────────────────────────────────────
def build_cost_sql(
    w_safety: float = 0.35,
    w_road: float = 0.25,
    w_deadend: float = 0.15,
    w_distance: float = 0.25,
) -> str:
    """
    COST MODEL:

        cost =
            base_cost
            + distance_component
            + safety_component
            + road_component
            + deadend_component
    """

    hc = _highway_case()

    # ✅ Balanced cost expression (FIXED)
    cost_expr = f"""
    (
        s.base_cost
        + (s.dist_m * {DISTANCE_SCALE:.1f} * {w_distance})
        + (4000 * {w_safety}  * s.safety_score)
        + (1200 * {w_road}    * s.road_score)
        + (2500 * {w_deadend} * s.deadend_score)
    )
    """.strip()

    return f"""
    WITH crime_max AS (
        SELECT COALESCE(MAX(raw_crime), 0.00001) AS v FROM mv_crime_agg
    ),

    report_max AS (
        SELECT
            COALESCE(MAX(road_w),    0.00001) AS road_max,
            COALESCE(MAX(safety_w),  0.00001) AS safety_max,
            COALESCE(MAX(deadend_w), 0.00001) AS deadend_max
        FROM mv_report_agg
    ),

    news_max AS (
        SELECT COALESCE(MAX(news_w), 0.00001) AS news_max FROM mv_news_agg
    ),

    -- ── CACHED SCORING ──────────────────────────────────────────────
    -- road length, historical crime aggregation, and dead-end topology
    -- used to be recomputed via CTEs on EVERY routing request. They're
    -- now precomputed once as a persisted column (len_m) and materialized
    -- views (mv_crime_agg, mv_dead_end_nodes), refreshed on a schedule —
    -- see cache_refresh.py — rather than recalculated per request. The
    -- live report/news aggregates (mv_report_agg, mv_news_agg) are also
    -- materialized, refreshed on every write plus a periodic timer, so
    -- routing only ever does a cheap indexed lookup here, never a raw
    -- spatial join over user_reports/news_crime_reports.
    scored AS (
        SELECT
            r.id,
            r.source,
            r.target,
            r.cost         AS base_cost,
            r.reverse_cost AS base_rev,
            r.len_m        AS dist_m,

            -- ✅ Normalized safety score, boosted by recent community
            -- reports (lighting/crime) and recent news-sourced crime
            -- signal on this segment — this is what keeps safety scoring
            -- from being purely the static historical dataset.
            LEAST(1.0,
                LEAST(1.0, GREATEST(0.0,
                    COALESCE(ca.raw_crime, 0) / NULLIF(cm.v, 0.00001)
                ))
                + {REPORT_BLEND_CAP} * LEAST(1.0,
                    COALESCE(ra.safety_w, 0) / rm.safety_max
                  )
                + {NEWS_BLEND_CAP} * LEAST(1.0,
                    COALESCE(na.news_w, 0) / nm.news_max
                  )
            ) AS safety_score,

            -- ✅ Road-type penalty, boosted by recent pothole /
            -- road-condition / flooding reports
            LEAST(1.0,
                ({hc})
                + {REPORT_BLEND_CAP} * LEAST(1.0,
                    COALESCE(ra.road_w, 0) / rm.road_max
                  )
            ) AS road_score,

            -- ✅ Stronger dead-end penalty (FIXED), promoted to 1.0 if
            -- recent reports flag this segment as blocked/dead-end even
            -- when it isn't a true degree-1 node in the topology
            GREATEST(
                CASE WHEN de.node_id IS NOT NULL THEN 1.0 ELSE 0.0 END,
                LEAST(1.0, COALESCE(ra.deadend_w, 0) / rm.deadend_max)
            ) AS deadend_score

        FROM osm_roads r
        LEFT JOIN mv_crime_agg ca ON r.id = ca.road_id
        LEFT JOIN mv_dead_end_nodes de ON r.target = de.node_id
        LEFT JOIN mv_report_agg ra ON r.id = ra.road_id
        LEFT JOIN mv_news_agg na ON r.id = na.road_id
        CROSS JOIN crime_max cm
        CROSS JOIN report_max rm
        CROSS JOIN news_max nm
    )

    SELECT
        s.id,
        s.source,
        s.target,
        s.safety_score,

        ST_X(v1.the_geom) AS x1,
        ST_Y(v1.the_geom) AS y1,
        ST_X(v2.the_geom) AS x2,
        ST_Y(v2.the_geom) AS y2,

        {cost_expr} AS cost,

        CASE
            WHEN s.base_rev < 0 THEN -1
            ELSE {cost_expr}
        END AS reverse_cost

    FROM scored s
    JOIN osm_roads_vertices_pgr v1 ON s.source = v1.id
    JOIN osm_roads_vertices_pgr v2 ON s.target = v2.id

    WHERE s.base_cost > 0
    AND s.source IN (SELECT node FROM main_component_nodes)
    AND s.target IN (SELECT node FROM main_component_nodes)
    """