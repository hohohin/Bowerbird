import React from "react";
import ReactDOM from "react-dom/client";
import { ScreenshotWindow } from "./components/ScreenshotWindow";
import { OverlayScrollbars } from "./components/OverlayScrollbars";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { lazyModule } from "./lib/lazyModule";
import { applyTheme, loadCachedTheme } from "./lib/theme";
import { installTextContextMenu } from "./lib/textContextMenu";
import "./styles.css";

const App = lazyModule(() => import("./App"));
const screenshotMode = new URLSearchParams(location.search).get("screenshot");

applyTheme(loadCachedTheme());
const removeTextContextMenu = installTextContextMenu();
if (import.meta.hot) import.meta.hot.dispose(removeTextContextMenu);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayScrollbars />
    <AppErrorBoundary>
      {screenshotMode ? <ScreenshotWindow pinned={screenshotMode === "pin"} /> : <React.Suspense fallback={null}><App /></React.Suspense>}
    </AppErrorBoundary>
  </React.StrictMode>
);
