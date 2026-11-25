import type { AnnotationMeta } from "./types";
import type { DraftCanvasSaver, DraftEditorRequest } from "../store";

type AnnotationSave = (dataUrl: string, meta: AnnotationMeta, fileName: string) => Promise<void>;
type CanvasCallbacks = {
  flush: (() => Promise<void>) | null;
  rename: ((title: string) => Promise<void>) | null;
  prepareAnnotation: (() => AnnotationSave | null) | null;
  prepareDraft: ((request: DraftEditorRequest) => DraftCanvasSaver | null) | null;
};

export const projectCanvasCallbacks: CanvasCallbacks = { flush: null, rename: null, prepareAnnotation: null, prepareDraft: null };

export function registerProjectCanvasCallback<K extends keyof CanvasCallbacks>(name: K, callback: NonNullable<CanvasCallbacks[K]>) {
  projectCanvasCallbacks[name] = callback;
  return () => {
    if (projectCanvasCallbacks[name] === callback) projectCanvasCallbacks[name] = null;
  };
}
