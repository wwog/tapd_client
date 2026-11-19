import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { initAppearance } from "./lib/appearance";
import { subscribeLocale } from "./lib/i18n";
import { startServiceFailures } from "./lib/services";
import { preloadShellBootstrap } from "./lib/shellBootstrap";
import { revealIslandWhenPainted, revealWhenPainted } from "./lib/startup";
import { loadUiPrefs } from "./lib/uiPrefs";
import { ServiceFailureModal } from "./components/ServiceFailureModal";
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
  useEffect(() => {
    revealWhenPainted();
    // A service that failed before this window painted still has to surface.
    startServiceFailures();
  }, []);
  return (
    <React.StrictMode>
      <App />
      <ServiceFailureModal />
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
// The main window also preloads the project snapshots the side bar switches on
// (session, cached projects, local projects), so the column is shown or hidden
// correctly on that first frame instead of popping in a moment later. The window
// stays hidden until `ui_ready`, so the extra IPC costs no flash.
void (async () => {
  await Promise.all([
    loadUiPrefs(),
    isOverlay ? Promise.resolve() : preloadShellBootstrap(),
  ]);
  // The island reads the same appearance so the capsule follows the app theme;
  // it just never paints a native window background (it must stay transparent).
  initAppearance({ windowBackground: !isOverlay, overlay: isOverlay });
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  // Messages are resolved synchronously by `t()`, so a language switch needs a
  // fresh render pass. Re-rendering the same component type preserves state and
  // navigation; remounting would kick the user out of the settings page. The
  // element has to be new each time or React bails out as an identity match.
  const render = () => root.render(isOverlay ? <IslandShell /> : <MainWindow />);
  subscribeLocale(render);
  root.render(content);
})();
