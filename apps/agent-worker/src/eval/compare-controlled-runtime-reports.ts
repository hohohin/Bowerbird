import { readFileSync, writeFileSync } from "node:fs";
import {
  compareControlledRuntimes,
  renderControlledRuntimeComparison,
  type ControlledRuntimeObservation,
} from "./controlled-runtime-comparison.ts";

function main(): void {
  const paths = process.argv.slice(2);
  const outputPath = paths.at(-1);
  const inputPaths = paths.slice(0, -1);
  if (!outputPath || !inputPaths.length) {
    throw new Error("usage: compare-controlled-runtime-reports <observations.json> [more-observations.json] <report.md>");
  }
  const observations = inputPaths.flatMap((inputPath) => {
    const value = JSON.parse(readFileSync(inputPath, "utf8")) as { observations?: ControlledRuntimeObservation[] };
    if (!Array.isArray(value.observations)) throw new Error("controlled_runtime_observations_missing");
    return value.observations;
  });
  const comparison = compareControlledRuntimes(observations);
  writeFileSync(outputPath, renderControlledRuntimeComparison(comparison), "utf8");
  console.log(`report=${outputPath}`);
  if (!comparison.qualityNoRegression) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "controlled_runtime_comparison_failed");
  process.exitCode = 1;
}
