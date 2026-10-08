# ai_briefing.py
#
# "Route Safety Briefing" — the second AI feature, and the one meant to
# actually be visible in a demo. ml_model.py's regressor learns quietly
# in the background; this one produces a short paragraph a person can
# read and judge for themselves.
#
# Deliberately grounded, not a free-floating LLM guess: the prompt hands
# the model the route's ACTUAL computed safety_score/road_score/
# deadend_score (from cost_engine.py), plus whatever real community
# reports and news articles fall near the route (reports.py /
# news_ingest.py — same tables the routing cost model itself reads from),
# and explicitly instructs it not to invent specifics beyond that. The
# LLM's job is narration, not data generation.
#
# Gated behind ANTHROPIC_API_KEY exactly like news_ingest.py's
# NEWS_API_KEY: unset means "feature unavailable", returned cleanly as
# available: False — never a crash, and never a fabricated response
# pretending to be AI-generated when it isn't.

import os
import requests

from reports import reports_near_coords
from news_ingest import news_near_coords

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# Override via ANTHROPIC_MODEL if this drifts out of date — model names
# change over time and this project has no way to auto-detect the
# current one.
DEFAULT_MODEL = "claude-3-5-sonnet-20241022"

MAX_REPORTS_IN_PROMPT = 5
MAX_NEWS_IN_PROMPT = 5


def _build_prompt(route_summary, reports, news, hour, mode):
    lines = [
        "You are writing a short safety briefing for SafeRoute, a "
        "crime-aware navigation app for South Bengaluru. A route has "
        "just been computed; here is everything known about it:",
        "",
        f"Route mode: {mode}",
    ]

    if route_summary.get("distance_km") is not None:
        lines.append(f"Distance: {route_summary['distance_km']} km")
    if route_summary.get("eta_min") is not None:
        lines.append(f"Estimated time: {route_summary['eta_min']} minutes")
    if route_summary.get("safety_pct") is not None:
        lines.append(
            f"Computed safety rating: {route_summary['safety_pct']}% "
            f"(this blends historical crime data, live community reports, "
            f"and recent news — higher is safer)"
        )
    if hour is not None:
        lines.append(f"Time of travel: {hour}:00")

    if reports:
        lines.append("")
        lines.append("Live community-reported issues near this route:")
        for r in reports[:MAX_REPORTS_IN_PROMPT]:
            desc = f" — \"{r['description']}\"" if r.get("description") else ""
            lines.append(f"- {r['issue_type']} (severity: {r['severity']}){desc}")

    if news:
        lines.append("")
        lines.append("Recent news articles near this route:")
        for n in news[:MAX_NEWS_IN_PROMPT]:
            lines.append(f"- \"{n['headline']}\" ({n['crime_type']}, severity: {n['severity']})")

    if not reports and not news:
        lines.append("")
        lines.append("No live community reports or recent news near this route.")

    lines.append("")
    lines.append(
        "Write a short, plain-English safety briefing (2-4 sentences) for "
        "someone about to take this route. Base it ONLY on the data given "
        "above — do not invent specific streets, incidents, or statistics "
        "that aren't listed. If nothing notable was reported, say the "
        "route looks routine based on available data rather than "
        "manufacturing a concern. Be direct and practical, not alarmist."
    )
    return "\n".join(lines)


def generate_route_briefing(
    route_summary,
    src_lat=None, src_lon=None, dst_lat=None, dst_lon=None,
    hour=None, mode="safe", route_coords=None,
):
    """
    Returns:
      {"available": False, "reason": "..."}                          — no key / request failed
      {"available": True, "briefing": "...", "sources_used": {...}}  — success
    Never raises — a failure here should never take route computation
    down with it.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"available": False, "reason": "ANTHROPIC_API_KEY not set"}

    nearby_reports, nearby_news = [], []
    if route_coords:
        try:
            nearby_reports = reports_near_coords(route_coords, radius_m=150)
        except Exception as e:
            print(f"[AI BRIEFING] reports lookup failed: {e}")
        try:
            nearby_news = news_near_coords(route_coords, radius_m=250)
        except Exception as e:
            print(f"[AI BRIEFING] news lookup failed: {e}")

    prompt = _build_prompt(route_summary, nearby_reports, nearby_news, hour, mode)

    try:
        resp = requests.post(
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL),
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        text = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        ).strip()

        if not text:
            return {"available": False, "reason": "empty response from model"}

        return {
            "available": True,
            "briefing": text,
            "sources_used": {
                "reports": len(nearby_reports),
                "news": len(nearby_news),
            },
        }
    except requests.exceptions.RequestException as e:
        return {"available": False, "reason": f"LLM request failed: {e}"}
    except Exception as e:
        return {"available": False, "reason": f"unexpected error: {e}"}
