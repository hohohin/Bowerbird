import { useEffect } from "react";
import { observeLibraryChatCompletion } from "../lib/libraryGenerationRuntime";

/** Observes the existing runtimes; mounting or restoring history never submits a task. */
export function LibraryGenerationCoordinator() {
  useEffect(observeLibraryChatCompletion, []);
  return null;
}
