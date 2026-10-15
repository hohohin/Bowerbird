import { createRoot } from "react-dom/client";
import { ScreenshotWindow } from "./components/ScreenshotWindow";
import "./screenshot.css";

createRoot(document.getElementById("root")!).render(
  <ScreenshotWindow pinned={new URLSearchParams(location.search).get("screenshot") === "pin"} />
);
