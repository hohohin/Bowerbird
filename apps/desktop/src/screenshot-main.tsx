import { createRoot } from "react-dom/client";
import { ScreenshotWindow } from "./components/ScreenshotWindow";
import { OverlayScrollbars } from "./components/OverlayScrollbars";
import { installTextContextMenu } from "./lib/textContextMenu";
import "./screenshot.css";

const removeTextContextMenu = installTextContextMenu();
if (import.meta.hot) import.meta.hot.dispose(removeTextContextMenu);

createRoot(document.getElementById("root")!).render(
  <><OverlayScrollbars /><ScreenshotWindow pinned={new URLSearchParams(location.search).get("screenshot") === "pin"} /></>
);
