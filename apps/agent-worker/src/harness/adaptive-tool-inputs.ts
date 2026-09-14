/** The same closed input contract is shown to the Agent and used by validation. */
export const ADAPTIVE_TOOL_INPUTS: Record<string, string> = {
  generate_image: '{"prompt":"Describe the desired image and reference roles","assetIds":[]}',
  inspect_artifact: '{"assetId":"image id","goal":"What to check","focus":"general|subject|text|layout|style"}',
  compose_html: '{"html":"Static HTML, images use asset:reference-N in assetIds order","assetIds":["image ids"]}',
  render_html: '{"documentId":"compose_html output artifactId"}',
  finalize_output: '{"assetIds":["selected generated or rendered image ids, exactly outputCount"]}',
};

export function adaptiveInputContract(toolName: string) {
  const input = ADAPTIVE_TOOL_INPUTS[toolName];
  return { input, requiredFields: Object.keys(JSON.parse(input)), additionalProperties: false,
    ...(toolName === "generate_image" ? {
      instructions: "Both prompt and assetIds are required. With no reference images, explicitly send assetIds: []. Otherwise list authorized input or generated image ids; do not omit intended references.",
    } : {}) };
}

export class AdaptiveInputError extends Error {
  readonly missingFields: string[];
  constructor(missingFields: string[]) {
    super("adaptive_input_invalid");
    this.missingFields = missingFields;
  }
}

export function validateAdaptiveInputObject(toolName: string, value: unknown): Record<string, unknown> {
  const required = adaptiveInputContract(toolName).requiredFields;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  const missing = required.filter(key => !keys.includes(key));
  if (!isObject || missing.length || keys.length !== required.length) throw new AdaptiveInputError(missing);
  return value as Record<string, unknown>;
}
