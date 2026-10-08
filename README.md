# SafeRoute

SafeRoute is a route planner that cares about safety as well as speed. Instead of only picking the shortest path, it scores each road segment using crime data, community reports and recent news, and lets you compare routes by distance, travel time and safety.

I built it as part of my dissertation project. It has a Flask backend, a React web app and a mobile client, all talking to the same API.

## What it does

- Scores routes by safety, so you can choose between the fastest option and a safer one.
- Lets users report problems on the map. Reports show up straight away and affect route scores, with older reports counting for less over time.
- Pulls in crime-related news (through NewsAPI) and historical crime data linked to the OpenStreetMap road network.
- Treats dead-end roads as a risk factor.
- Predicts how satisfied a user is likely to be with each route type, using a model trained on past feedback.
- Can explain a route in plain English ("Why this route?"), using the route's real numbers and any nearby reports or news. This uses the Anthropic API and is optional.

## Project layout

```
SafeRoute/
  backend/      Flask API, cost engine, ML model, route briefing, SQL migrations
  frontend/     React (Vite) web app
  mobile/       Mobile client
  SETUP_GUIDE.md
```

The backend uses PostgreSQL with the OSM road network loaded. The slower safety queries are cached as materialized views and refreshed every few minutes. The satisfaction model uses scikit-learn.

## Getting started

You will need Python 3, Node.js 18 or newer, and a PostgreSQL database that already contains your OSM road data. API keys for NewsAPI and Anthropic are optional.

### Database

Run the migrations in order. The caching migration depends on the reports and news tables, so run it after `003_user_reports.sql` and `004_news_crime_reports.sql`:

```
psql -U postgres -d <your_db> -f migrations/006_query_caching.sql
```

To check it worked, both of these should return a non-zero count:

```
SELECT COUNT(*) FROM mv_dead_end_nodes;
SELECT COUNT(*) FROM mv_crime_agg;
```

### Backend

```
cd backend
pip install -r requirements.txt
cp .env.example .env
python app.py
```

Fill in `.env` before starting. The settings are:

| Variable | Required | Notes |
| --- | --- | --- |
| `DB_*` | Yes | Database connection details |
| `NEWS_API_KEY` | No | Turns on automatic news ingestion |
| `ANTHROPIC_API_KEY` | No | Turns on the route briefing |
| `DB_POOL_MIN`, `DB_POOL_MAX` | No | Connection pool size, defaults to 2 and 10 |
| `CACHE_REFRESH_INTERVAL_MIN` | No | How often views refresh, defaults to 5 |

The API runs on `http://localhost:5001`. If you leave out the Anthropic key, the briefing endpoint just reports that it is unavailable and everything else works as normal.

### Frontend

```
cd frontend
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:5173`. In development, Vite forwards `/api` requests to the Flask server, so there is nothing to configure for CORS. For a production build, run `npm run build` and serve the `dist/` folder. If the API is on a different origin, set `VITE_API_BASE_URL` first.

## Useful endpoints

| Endpoint | Method | What it does |
| --- | --- | --- |
| `/api/cache/status` | GET | Row counts for the cached views |
| `/api/cache/rebuild-definitions` | POST | Rebuilds the view definitions (see notes below) |
| `/api/ai/model-status` | GET | Model status and feature importances |
| `/api/ai/retrain` | POST | Retrains the satisfaction model |
| `/api/ai/briefing` | POST | Returns a plain-English route explanation |

Example briefing request:

```
curl -X POST http://localhost:5001/api/ai/briefing \
  -H "Content-Type: application/json" \
  -d '{"route": {"distance_km": 4.2, "eta_min": 14, "safety_pct": 72}, "mode": "safe", "hour": 22}'
```

Note that `safety_pct` is higher for safer routes.

## Things to know

- The satisfaction model needs at least 15 rows in `user_feedback` before it trains. Until then, no predictions are shown, so a missing rating badge usually just means there isn't enough data yet.
- The news and cache-refresh schedulers run as background threads inside the app. That is fine with a single process. With several gunicorn workers, each one runs its own copy, which is harmless but wasteful. A proper cron or Celery job would be better.
- The cached views have the recency half-lives and severity weights baked in. If you change `REPORT_HALF_LIFE_S`, `NEWS_HALF_LIFE_S` or the severity weights in `cost_engine.py`, call `POST /api/cache/rebuild-definitions` once. A normal refresh won't pick up a changed definition.
- The collapsed search panel in the frontend has a small visual glitch. It doesn't affect how anything works.

## License

No license has been added yet.
