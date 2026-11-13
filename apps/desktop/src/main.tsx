import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { initAppearance } from "./lib/appearance";
import { revealIslandWhenPainted, revealWhenPainted } from "./lib/startup";
import { loadUiPrefs } from "./lib/uiPrefs";
import { IslandWindow } from "./windows/IslandWindow";
import "./styles.css";

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Browser preview outside Tauri: fall back to the main app.
}

const isOverlay = label === "island" || label === "notification";

// The capsule page must be transparent from its very first frame: painting the
// canvas colour would show as an opaque pill before React's effects run.
if (isOverlay) document.documentElement.dataset.overlay = "true";

/** Main window shell: reveals the native window once this tree is painted. */
function MainWindow() {
  useEffect(() => revealWhenPainted(), []);
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

/** Capsule shell: reveals the native window once the transparent frame is up. */
function IslandShell() {
  useEffect(() => revealIslandWhenPainted(), []);
  return <IslandWindow />;
}

const content = isOverlay ? <IslandShell /> : <MainWindow />;

// Preferences live in config.json (logout wipes WebView storage), so read them
// before the first render: the themed frame must be the first frame painted.
// The window stays hidden until `ui_ready`, so the extra IPC costs no flash.
void (async () => {
  await loadUiPrefs();
  // The island reads the same appearance so the capsule follows the app theme;
  // it just never paints a native window background (it must stay transparent).
  initAppearance({ windowBackground: !isOverlay, overlay: isOverlay });
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(content);
})();
