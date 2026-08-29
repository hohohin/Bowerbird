import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";

const PROOF_PREFIX = "bowerbird-u1-private-proof:";

function proofFor(nonce) {
  return createHash("sha256").update(`${PROOF_PREFIX}${nonce}`).digest("hex");
}

export const name = "u1-fixture-tool";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "u1_record_observation",
      description:
        "Required U1 compatibility probe. Record the supplied nonce and return an opaque execution proof.",
      parameters: {
        nonce: {
          type: "string",
          required: true,
          description: "The nonce supplied by the user, copied exactly.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nonce: { type: "string", required: true },
            proof: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: JSON.stringify(value),
          },
        ],
      },
      async execute(args) {
        return {
          nonce: args.nonce,
          proof: proofFor(args.nonce),
        };
      },
    }),
  );
}
