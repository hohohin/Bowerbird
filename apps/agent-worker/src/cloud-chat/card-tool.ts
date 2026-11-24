import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadChatCardTool(options: { imageCardProvider?: boolean; videoCardOptions?: boolean; h3R2v?: boolean } = {}) {
  const tool = JSON.parse(readFileSync(join(import.meta.dirname, "../../../cloud/supabase/functions/_shared/chat-card-tool.json"), "utf8"));
  const fields = tool.inputSchema.properties.cards.items.properties;
  if (!options.imageCardProvider) delete fields.provider;
  if (options.h3R2v !== true || options.videoCardOptions !== true) {
    fields.mode.enum = fields.mode.enum.filter((mode: string) => mode !== "r2v");
    fields.mode.description = fields.mode.description.split(" Use r2v")[0];
    fields.referenceAliases.description = "generation only.";
    fields.resolution.description = fields.resolution.description.replace("/r2v", "");
    const input = tool.inputSchema.properties.connections.items.properties.input;
    input.enum = input.enum.filter((port: string) => port !== "reference-image" && port !== "reference-video");
    tool.description = tool.description.split(" H3 R2V uses mode r2v.")[0];
  }
  if (options.videoCardOptions !== true) {
    delete fields.videoChannel;
    delete fields.videoOptions;
    fields.mode.enum = ["count", "rows"];
    fields.mode.description = "loop only: count repeats the body; rows feeds source table rows to the body.";
    fields.resolution.enum = [0.6, 0.8, 1];
    tool.description = tool.description
      .replace("H3 video mode is text, reference (one image), or frames (default, first and optional last frame). ", "")
      .replace("Frames may be omitted to create a draft; frames mode requires a first frame to run, reference mode requires one image, text mode needs none.", "Frames may be omitted to create a draft; running H3 requires a first frame.");
  }
  return tool;
}
