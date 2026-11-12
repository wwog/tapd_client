import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { initPrefs } from "./lib/prefs";
import "./styles.css";

// Theme and font size apply before the first paint so the first frame is
// already in the right theme (mobile twin of the desktop's initAppearance).
initPrefs();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
