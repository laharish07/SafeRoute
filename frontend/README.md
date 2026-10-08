# SafeRoute — Web Frontend (React)

A full rewrite of the original server-rendered Flask/vanilla-JS frontend,
as a standalone Vite + React app talking to the same Flask API.

## Design — "Night Map"

The old frontend was a dark theme but read as a generic admin dashboard.
This one leans into the actual subject: navigating safely after dark.
Deep navy-black base (not flat grey-black), a cool "beacon" blue as the
one interactive accent — kept deliberately separate from the three
semantic risk colors (safe/green, caution/amber, danger/coral) so they
never compete for meaning — Space Grotesk for headlines/data, Inter for
body text. Layout is map-dominant: a floating HUD search panel on the
left instead of a space-eating sidebar, and route options as a bottom
card rail (closer to how Google/Apple Maps actually present route
choices) rather than a buried list.

## Setup

```bash
cd frontend
npm install
cp .env.example .env     # defaults are fine for local dev
npm run dev               # http://localhost:5173
```

The dev server proxies `/api/*` to the Flask backend at
`http://localhost:5001` (see `vite.config.js`) — make sure the backend
is running first (`cd ../backend && python app.py`).

For a production build:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally to sanity-check
```

Set `VITE_API_BASE_URL` in `.env` before building if the Flask API will
be hosted somewhere other than the same origin as the built frontend.

## Structure

```
src/
├── api/
│   ├── client.js      One function per backend endpoint
│   └── geocode.js      Nominatim search (same service the old frontend used)
├── components/
│   ├── MapView.jsx        Leaflet map — routes, markers, all 5 overlays
│   ├── TopBar.jsx          Logo, live news-feed badge, report button
│   ├── SearchPanel.jsx      Source/destination, overlay toggles
│   ├── LocationField.jsx     Geocoding search input
│   ├── RouteRail.jsx          Bottom card rail
│   ├── RouteCard.jsx           One route mode (distance/eta/safety/AI rating)
│   ├── AIBriefing.jsx           LLM-generated route safety explanation
│   ├── ReportModal.jsx           Community issue reporting
│   ├── FeedbackModal.jsx          Post-trip star ratings
│   └── StarRating.jsx              Reusable star input
├── styles/
│   ├── tokens.css      Design tokens (colors, type, shape)
│   └── app.css          Everything else
├── App.jsx            Central state + layout
└── main.jsx             Entry point
```

No Redux/Context — state lives in `App.jsx` and flows down via props.
At this scale (one screen, maybe a dozen pieces of state) a state
library would be overhead, not help; if the app grows multiple routes/
screens later, that's the point to reconsider.

## Known minor polish item

The search panel's collapsed state (the `‹`/`›` toggle) has a small
cosmetic sliver artifact above the collapse button — doesn't affect
functionality (confirmed via automated click-testing, zero console
errors), just not fully pixel-polished yet.

## What talks to what

- `/api/route/multi` → all 4 route cards in one call, each already
  carrying `ai_predicted_rating` if the ML model is trained (see
  `backend/ml_model.py`)
- `/api/ai/briefing` → triggered by "✨ Why this route?" on the selected
  card, returns `{available: false, reason}` if `ANTHROPIC_API_KEY` isn't
  set on the backend — `AIBriefing.jsx` renders that state cleanly rather
  than erroring
- `/api/report`, `/api/feedback` → the two modals
- `/api/{crime,deadends,roadquality,reports,news}/route` → the 5 map
  layer toggles, fetched once per session and cached in React state
  (not refetched on every toggle)
- `/api/news/status` → the top-bar live-feed badge, polled every 5 min
