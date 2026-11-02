import React from "react";
import ReactDOM from "react-dom/client";
import { ScreenshotWindow } from "./components/ScreenshotWindow";
import { OverlayScrollbars } from "./components/OverlayScrollbars";
import { applyTheme, loadCachedTheme } from "./lib/theme";
import "./styles.css";

const App = React.lazy(() => import("./App"));
const screenshotMode = new URLSearchParams(location.search).get("screenshot");

applyTheme(loadCachedTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayScrollbars />
    {screenshotMode ? <ScreenshotWindow pinned={screenshotMode === "pin"} /> : <React.Suspense fallback={null}><App /></React.Suspense>}
  </React.StrictMode>
);
