import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { subscribeLocale } from "./lib/i18n";
import { initPrefs } from "./lib/prefs";
import "./styles.css";

// Theme and font size apply before the first paint so the first frame is
// already in the right theme (mobile twin of the desktop's initAppearance).
initPrefs();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/** Messages resolve synchronously, so a language switch needs a fresh render.
 *  A new element each time; the same object would let React bail out. */
const render = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

subscribeLocale(render);
render();
