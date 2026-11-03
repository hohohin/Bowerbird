import { createRoot } from "react-dom/client";
import { ScreenshotWindow } from "./components/ScreenshotWindow";
import { OverlayScrollbars } from "./components/OverlayScrollbars";
import "./screenshot.css";

createRoot(document.getElementById("root")!).render(
  <><OverlayScrollbars /><ScreenshotWindow pinned={new URLSearchParams(location.search).get("screenshot") === "pin"} /></>
);
