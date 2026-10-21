import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

/** Render only; the cell and every workflow output retain the Markdown source. */
export const CanvasCellMarkdown = memo(function CanvasCellMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={plugins} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  }}>{text}</Markdown>;
});
