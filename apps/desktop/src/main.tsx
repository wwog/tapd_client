import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { initAppearance } from "./lib/appearance";
import { revealWhenPainted } from "./lib/startup";
import { IslandWindow } from "./windows/IslandWindow";
import "./styles.css";

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Browser preview outside Tauri: fall back to the main app.
}

const isOverlay = label === "island" || label === "notification";
// The island reads the same appearance so the capsule follows the app theme;
// it just never paints a native window background (it must stay transparent).
initAppearance({ windowBackground: !isOverlay, overlay: isOverlay });

/** Main window shell: reveals the native window once this tree is painted. */
function MainWindow() {
  useEffect(() => revealWhenPainted(), []);
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

const content = isOverlay ? <IslandWindow /> : <MainWindow />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(content);
