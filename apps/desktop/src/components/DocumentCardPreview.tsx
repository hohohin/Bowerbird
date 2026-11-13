import type { ReactNode, RefObject } from "react";
import { FileText } from "lucide-react";
import { TEXT_CARD_ASPECT_RATIO } from "../lib/textMedia";
import "./TextFileMediaCard.css";

/** Shared reading surface; the host owns selection, editing, data and canvas ports. */
export function DocumentCardPreview({ title, excerpt, readingHtml, format = "Markdown", aspectRatio = TEXT_CARD_ASPECT_RATIO, action, scrollable = false, previewRef }: {
  title: string; excerpt?: string; readingHtml?: string; format?: string; aspectRatio?: number; action?: ReactNode; scrollable?: boolean;
  previewRef?: RefObject<HTMLSpanElement>;
}) {
  return <span ref={previewRef} className="folder-media-preview text-file-preview document-card-preview" style={{ aspectRatio }}>
    <span className="text-file-heading"><FileText size={16} strokeWidth={1.25} aria-hidden="true"/><span className="text-file-title">{title}</span>{action}</span>
    <span className={`text-file-excerpt${scrollable ? " is-scrollable" : ""}`} tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? "region" : undefined} aria-label={scrollable ? `${title}正文` : undefined}
      onKeyDown={scrollable ? event => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) event.stopPropagation();
      } : undefined}
      onWheel={scrollable ? event => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); } : undefined}>
      {readingHtml === undefined ? excerpt : <span className="canvas-document-reading" dangerouslySetInnerHTML={{ __html: readingHtml }} />}
    </span>
    <span className="text-file-format">{format}</span>
  </span>;
}
