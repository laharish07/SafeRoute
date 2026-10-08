# SafeRoute — Setup Guide (Caching + AI + New Frontend)

Everything added in this round: query caching via materialized views, two
real AI features (a trained ML model + an LLM route briefing), and a
full React rewrite of the frontend. This is the step-by-step to get all
of it running from a clean checkout.

---

## 0. What's new, at a glance

| Area | Files | What changed |
|---|---|---|
| Caching | `db.py`, `cache_refresh.py`, `cost_engine.py`, `migrations/006_*.sql` | Real connection pooling (was fake); 5 heavy per-request CTEs replaced by 4 materialized views + 1 persisted column |
| AI #1 — trained model | `ml_model.py` | GradientBoostingRegressor trained on `user_feedback`, predicts satisfaction per route mode |
| AI #2 — LLM briefing | `ai_briefing.py` | Plain-English route explanation, grounded in real computed scores + live reports/news |
| Frontend | `frontend/` (new directory) | Full React (Vite) rewrite, same Flask API |

Two bugs were also found and fixed while wiring the AI features in:
`app.py`'s multi-route handler was reading fields (`distance_km`,
`eta_min`) off the wrong object — each route is a GeoJSON
`FeatureCollection`, so those live in `features[0].properties`, not at
the top level. `ai_briefing.py` had the same issue plus referenced a
`safety_score` field that doesn't exist (the real field is `safety_pct`,
and it's inverted — higher is *safer*, not riskier). Both are fixed in
this version.

---

## 1. Prerequisites

Same as before, plus:
- **Node.js 18+** and npm (for the frontend)
- Python packages: `scikit-learn`, `joblib`, `numpy` (added to
  `backend/requirements.txt`)
- Optional: a NewsAPI key (already had this), an Anthropic API key (new
  — for the LLM briefing feature)

---

## 2. Database — run the new migration

```bash
psql -U postgres -d mew -f migrations/006_query_caching.sql
```

This must run **after** `003_user_reports.sql` and
`004_news_crime_reports.sql` (it creates materialized views that join
against `user_reports` and `news_crime_reports`). It will:
- Add and backfill `osm_roads.len_m` (one-time `ST_Length()` pass over
  all ~35k edges — takes a few seconds)
- Create `mv_dead_end_nodes`, `mv_crime_agg`, `mv_report_agg`,
  `mv_news_agg`

Sanity check:
```sql
SELECT COUNT(*) FROM mv_dead_end_nodes;
SELECT COUNT(*) FROM mv_crime_agg;
```
Both should return non-zero counts (assuming your `osm_roads` /
`crime_road_link` tables already have data from the original Phase 1/2
setup).

---

## 3. Backend — install, configure, run

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
```

Fill in `.env`:
- `DB_*` — unchanged from before
- `NEWS_API_KEY` — unchanged from before (optional)
- `ANTHROPIC_API_KEY` — **new**, optional. Get one at
  console.anthropic.com. Without it, `/api/ai/briefing` returns
  `{"available": false, "reason": "ANTHROPIC_API_KEY not set"}` rather
  than erroring — the rest of the app is unaffected.
- `DB_POOL_MIN` / `DB_POOL_MAX` — new, defaults (2/10) are fine
- `CACHE_REFRESH_INTERVAL_MIN` — new, default 5 (minutes)

```bash
python app.py
```

Watch the startup log — you should see:
```
[NEWS] NEWS_API_KEY not set — auto-refresh disabled (endpoints still work manually)
[CACHE] dynamic view refresh scheduler started — every 5 min
```
(or the news line showing it *is* enabled, if you set a key)

### Verify caching is working
```bash
curl http://localhost:5001/api/cache/status
```
Should return row counts for all 4 materialized views.

### Verify the AI model
The satisfaction model needs **15+ rows** in `user_feedback` before it
trains (below that, predictions are just omitted — never an error).
```bash
curl http://localhost:5001/api/ai/model-status
```
If you've got existing feedback data from testing, trigger a manual
train:
```bash
curl -X POST http://localhost:5001/api/ai/retrain
```
Check the response's `feature_importances` — this is genuinely useful
to point at during a demo ("the model found X is what these ratings
correlate with most").

### Verify the LLM briefing (needs ANTHROPIC_API_KEY set)
```bash
curl -X POST http://localhost:5001/api/ai/briefing \
  -H "Content-Type: application/json" \
  -d '{"route": {"distance_km": 4.2, "eta_min": 14, "safety_pct": 72}, "mode": "safe", "hour": 22}'
```

---

## 4. Frontend — install and run

```bash
cd frontend
npm install
cp .env.example .env    # defaults are fine for local dev
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api/*` to the
Flask backend on `:5001` automatically (see `vite.config.js`) — no CORS
setup needed, same as the old same-origin server-rendered page got for
free.

For a production build: `npm run build` → static files in `dist/`,
servable from anywhere (Nginx, same as the old `static/` files were).
Set `VITE_API_BASE_URL` in `.env` first if the API will be hosted on a
different origin than wherever `dist/` ends up.

---

## 5. What to actually demo

In rough order of "how impressive is this to show live":

1. **Report an issue** → toggle the "Community reports" layer → watch
   it appear on the map immediately (cache refreshes on write, so no
   delay).
2. **Compute a route, click "✨ Why this route?"** on the selected
   card → the LLM briefing streams in, referencing the route's *actual*
   numbers and any real nearby reports/news — not a canned response.
3. **`/api/cache/status`** before/after a report submission — show the
   `mv_report_agg` row count changing, demonstrating the cache is live
   data, not a static snapshot.
4. **`/api/ai/model-status`** — the `feature_importances` output is a
   genuinely interesting thing to walk a panel through: it's not just
   "we used AI," it's "here's specifically what the model learned
   matters."
5. Submit a few feedback ratings (15+ needed) → `/api/ai/retrain` →
   watch the AI-predicted-rating badges on route cards update on the
   next search.

---

## 6. Known caveats (be upfront about these if asked)

- **Multi-worker production deployment**: both the news scheduler and
  the cache-refresh scheduler are in-process background threads. Under
  a single `python app.py` or single-worker gunicorn, this is fine. With
  multiple gunicorn workers, each worker runs its own copy of both
  schedulers — harmless (refreshes/ingestion are idempotent/deduped) but
  wasteful. A proper fix is an external cron/Celery beat job instead of
  in-process threads — exactly the kind of thing the dissertation's own
  Phase 3 "System Hardening" section already earmarks.
- **ML model cold start**: with under 15 feedback rows, there are no AI
  predictions at all (by design — not enough data to trust a fitted
  model over no prediction). This is the single most likely "why isn't
  the AI badge showing up" question during testing.
- **Materialized view constant drift**: `mv_report_agg` / `mv_news_agg`
  are defined with the recency half-life and severity weights hardcoded
  as of migration 006. If you ever change `REPORT_HALF_LIFE_S`,
  `NEWS_HALF_LIFE_S`, or the severity weight dicts in `cost_engine.py`,
  call `POST /api/cache/rebuild-definitions` once to regenerate the view
  definitions from the new constants — a normal `REFRESH` won't pick up
  a changed view *definition*, only changed underlying data.
- **Frontend collapsed-panel sliver**: a small cosmetic artifact in the
  search panel's collapsed state (see `frontend/README.md`) — doesn't
  affect functionality, just not fully pixel-polished.
