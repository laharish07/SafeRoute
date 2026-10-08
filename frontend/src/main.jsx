import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Bundled via npm instead of the external <link> tag index.html used to
// have — that CDN request was a failure point: if unpkg.com was blocked
// (ad blocker, firewall, flaky network), Leaflet's container never got
// its required base styles and the map silently rendered as a 0-height
// box. Bundling removes that dependency entirely.
import "leaflet/dist/leaflet.css";

import "./styles/tokens.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
