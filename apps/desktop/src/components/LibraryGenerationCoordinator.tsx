import { useEffect } from "react";
import { useStore } from "../store";
import { observeLibraryChatCompletion, observeLibraryLocalVideo, useLibraryGenerationRuntime } from "../lib/libraryGenerationRuntime";

/** Observes the existing runtimes; mounting or restoring history never submits a task. */
export function LibraryGenerationCoordinator() {
  const locators = useLibraryGenerationRuntime(state => state.locators);
  const projects = useStore(state => state.projects);
  useEffect(observeLibraryChatCompletion, []);
  useEffect(() => {
    const subscriptions = locators.filter(locator => projects.some(project => project.id === locator.projectId && project.archived_at == null))
      .map(observeLibraryLocalVideo);
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [locators, projects]);
  return null;
}
