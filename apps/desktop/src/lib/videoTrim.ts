import type { Asset } from "./types";

export interface VideoTrimRequest {
  sourcePath: string;
  start: number;
  end: number;
  overwrite: boolean;
}

export type SaveVideoTrim = (request: VideoTrimRequest) => Promise<Asset>;
