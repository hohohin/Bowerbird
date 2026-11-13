import { documentPreviewText, documentReadingHtml } from "./documentPreview";

self.onmessage = ({ data }: MessageEvent<{ source: string; format: "card" | "excerpt" }>) => {
  try {
    self.postMessage({ result: data.format === "card" ? documentReadingHtml(data.source) : documentPreviewText(data.source, "markdown") });
  } catch { self.postMessage({ failed: true }); }
};
