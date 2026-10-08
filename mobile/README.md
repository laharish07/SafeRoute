# SafeRoute — Expo (React Native) client

Mobile port of the standalone web frontend (`../frontend`, "Night Map" design),
rendered on **OpenStreetMap tiles** (standard OSM look, no API key).

## Run
```bash
cd mobile
npm install
npx expo install --fix
cp .env.example .env      # set EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:5001/api
npx expo start            # scan the QR with Expo Go (same Wi-Fi as the backend)
```
Check `http://<LAN-IP>:5001/api/health` from the phone first. Don't use `localhost`.

## How the OSM rendering works
`components/OsmMap.jsx` renders **Leaflet + standard OpenStreetMap tiles inside a WebView**
(`react-native-webview`) — the same renderer as the static Flask frontend. It does not use Google/Apple
maps, so it works in Expo Go on any phone with internet. RN sends map state (pins, route, overlays) into
the page with `injectJavaScript`; taps come back via `postMessage`. Needs: `npx expo install react-native-webview`.

## Design source
UI and behaviour are ported from the original Flask frontend (`backend/static/js/app.js`, `style.css`):
indigo/dark theme, Syne + DM Sans + DM Mono, single route with Safety / Better Roads / No Dead Ends
toggles, learned-weights bar, time-of-day preview, Route Insights overlays, recents-aware place search,
reverse-geocoded map pins, feedback + report modals. The sidebar becomes a draggable bottom sheet.

## Structure
```
App.jsx                 SafeAreaProvider + HomeScreen
screens/HomeScreen.jsx  all state (port of web App.jsx)
components/
  OsmMap.jsx            OSM tiles, routes (cased), pins, 5 overlays
  TopBar.jsx            brand, live-feed status, report toggle
  SearchPanel.jsx       source/destination, GPS, overlay chips, collapses after routing
  LocationField.jsx     Nominatim search (Bengaluru-bounded) + pick-on-map
  RouteRail.jsx / RouteCard.jsx / AIBriefing.jsx
  ReportModal.jsx / FeedbackModal.jsx / Sheet.jsx / StarRating.jsx
api/client.js, api/geocode.js, geo.js, theme.js (tokens from tokens.css)
```
Same endpoints as the web app: `/route/multi`, `/{crime,deadends,roadquality,reports,news}/route`,
`/ai/briefing`, `/report`, `/feedback`, `/news/status`.

## Notes
- Replaced the old 4-screen tab/stack navigation with one map-first screen (like the web app).
- Use Expo Go on a device/emulator (not `expo start --web`).
