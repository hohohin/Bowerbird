/** Domestic Ark Seedance 2.5 contract. Shared by Edge validation and VPS execution. */
export const SEEDANCE_MODEL = "doubao-seedance-2-5-260628";
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const VIDEO_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"];
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number];
export interface CloudVideoOptions {
  kind: "text2video" | "image2video" | "frames2video" | "multimodal2video";
  model_version: "seedance2.5";
  duration: number;
  video_resolution: VideoResolution;
  generate_audio?: boolean;
}
export interface VideoImage { mime: "image/jpeg" | "image/png"; base64: string }
export interface VideoReference { object_key: string; bytes: number; mime?: "video/mp4" | "video/quicktime" }
export interface VideoInput {
  schema_version: 1;
  media: "video";
  prompt: string;
  video_options: CloudVideoOptions;
  ratio: string | null;
  reference_images: VideoImage[];
  reference_videos: VideoReference[];
}

export function videoService(resolution: VideoResolution): string {
  return `video_seedance25_${resolution}`;
}

export function validateVideoInput(value: VideoInput): void {
  if (!value || value.schema_version !== 1 || value.media !== "video") throw new Error("video_input_invalid");
  const options = value.video_options;
  if (!options || options.model_version !== "seedance2.5") throw new Error("video_model_invalid");
  if (!VIDEO_RESOLUTIONS.includes(options.video_resolution)) throw new Error("video_resolution_invalid");
  if (!Number.isInteger(options.duration) || options.duration < 4 || options.duration > 30) throw new Error("video_duration_invalid");
  if (options.generate_audio !== undefined && typeof options.generate_audio !== "boolean") throw new Error("video_audio_invalid");
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 20_000) throw new Error("video_prompt_invalid");
  // Weak prompt parameters must not override the strongly validated body or the quoted duration.
  if (/(?:^|\s)--(?:resolution|rs|ratio|rt|duration|dur|frames|fps|seed|camera_fixed|cf|watermark|wm)\b/i.test(value.prompt)) throw new Error("video_prompt_parameters_forbidden");
  if (!Array.isArray(value.reference_images) || !Array.isArray(value.reference_videos)) throw new Error("video_references_invalid");
  const images = value.reference_images.length;
  const videos = value.reference_videos.length;
  if (images > 30 || videos > 10) throw new Error("video_references_limit");
  for (const image of value.reference_images) {
    if (!image || !["image/jpeg", "image/png"].includes(image.mime) || typeof image.base64 !== "string" || !image.base64 || image.base64.length % 4 !== 0 || image.base64.length >= 40 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) throw new Error("video_image_invalid");
  }
  if (value.ratio !== null && !VIDEO_RATIOS.includes(value.ratio)) throw new Error("video_ratio_invalid");
  switch (options.kind) {
    case "text2video": if (images || videos) throw new Error("video_text_references_forbidden"); break;
    case "image2video":
    case "frames2video":
      if (videos || images !== (options.kind === "image2video" ? 1 : 2)) throw new Error("video_frame_count_invalid");
      if (value.ratio !== null && value.ratio !== "adaptive") throw new Error("video_frames_require_adaptive");
      break;
    case "multimodal2video": if (!images && !videos) throw new Error("video_references_required"); break;
    default: throw new Error("video_kind_invalid");
  }
  for (const video of value.reference_videos) {
    if (!video || typeof video.object_key !== "string" || (video.mime !== undefined && !["video/mp4", "video/quicktime"].includes(video.mime)) || !Number.isSafeInteger(video.bytes) || video.bytes <= 0 || video.bytes > 200 * 1024 * 1024) throw new Error("video_reference_invalid");
  }
}

/** URLs are issued by the control plane after checking ownership; never accept client URLs. */
export function arkVideoBody(input: VideoInput, referenceVideoUrls: string[] = []) {
  validateVideoInput(input);
  if (referenceVideoUrls.length !== input.reference_videos.length || referenceVideoUrls.some(url => !url.startsWith("https://"))) throw new Error("video_reference_urls_invalid");
  const kind = input.video_options.kind;
  const body = {
    model: SEEDANCE_MODEL,
    content: [
      { type: "text", text: input.prompt },
      ...input.reference_images.map((image, index) => ({
        type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` },
        role: kind === "image2video" ? "first_frame" : kind === "frames2video" ? (index === 0 ? "first_frame" : "last_frame") : "reference_image",
      })),
      ...referenceVideoUrls.map(url => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
    ],
    duration: input.video_options.duration,
    resolution: input.video_options.video_resolution,
    ratio: input.ratio ?? "adaptive",
    generate_audio: input.video_options.generate_audio ?? false,
    output_format: "mp4",
    // MVP multimodal mode creates a new video; editing/extension needs separate duration semantics.
    ...(kind === "multimodal2video" ? { omni_reference_task_type: "reference" } : {}),
    execution_expires_after: 86400,
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024 * 1024) throw new Error("video_body_limit");
  return body;
}

/** Conservative reservation units, not a guarantee of upstream monetary cost. */
export function videoReservationTokens(input: VideoInput): number {
  validateVideoInput(input);
  const pixels = { "480p": 992 * 432, "720p": 1112 * 834, "1080p": 2206 * 946 }[input.video_options.video_resolution];
  const seconds = input.video_options.duration + (input.reference_videos.length ? 30 : 0);
  return Math.ceil(seconds * pixels * 24 / 1024);
}
