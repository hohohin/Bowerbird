import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { TEXT_CARD_ASPECT_RATIO } from "../lib/textMedia";
import "./TextFileMediaCard.css";

/** Shared reading surface; the host owns selection, editing, data and canvas ports. */
export function DocumentCardPreview({ title, excerpt, format = "Markdown", aspectRatio = TEXT_CARD_ASPECT_RATIO, action, scrollable = false }: {
  title: string; excerpt: string; format?: string; aspectRatio?: number; action?: ReactNode; scrollable?: boolean;
}) {
  return <span className="folder-media-preview text-file-preview document-card-preview" style={{ aspectRatio }}>
    <span className="text-file-heading"><FileText size={16} strokeWidth={1.25} aria-hidden="true"/><span className="text-file-title">{title}</span>{action}</span>
    <span className={`text-file-excerpt${scrollable ? " is-scrollable" : ""}`} onWheel={scrollable ? event => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); } : undefined}>{excerpt}</span>
    <span className="text-file-format">{format}</span>
  </span>;
}
