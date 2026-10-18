export interface VideoFrame {
  path: string;
  time: number;
  dataUrl: string;
}

export function videoTime(value: number) {
  const ms = Math.max(0, Math.round(value * 1000));
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Capture decoded pixels, never the scaled player, controls or thumbnail strip. */
export function captureVideoFrame(video: HTMLVideoElement, path: string): VideoFrame {
  if (!video.paused || video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("请等待画面定位完成后再添加");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法读取当前视频画面");
  context.drawImage(video, 0, 0);
  return { path, time: video.currentTime, dataUrl: canvas.toDataURL("image/png") };
}

/** Seek just inside the end, avoiding the empty position after the final frame. */
export async function seekVideoLastFrame(video: HTMLVideoElement): Promise<void> {
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("无法读取视频时长");
  video.pause();
  const target = Math.max(0, video.duration - Math.min(0.001, video.duration / 2));
  if (video.currentTime === target && !video.seeking && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.removeEventListener("emptied", onError);
      if (error) reject(error); else resolve();
    };
    const onSeeked = () => {
      if (!video.seeking && video.readyState >= 2) finish();
    };
    const onError = () => finish(new Error("尾帧读取失败，请重新打开视频后重试"));
    const timeout = window.setTimeout(() => finish(new Error("尾帧定位超时，请重试")), 10000);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.addEventListener("emptied", onError);
    try { video.currentTime = target; } catch { onError(); }
  });
}

/** Decode on demand for a connected video output, without opening the player. */
export async function readVideoLastFrame(src: string, path: string): Promise<VideoFrame> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        video.onloadeddata = video.onerror = null;
        if (error) reject(error); else resolve();
      };
      const timeout = window.setTimeout(() => finish(new Error("视频尾帧加载超时，请重试")), 10000);
      video.onloadeddata = () => finish();
      video.onerror = () => finish(new Error("无法读取视频尾帧，请检查视频文件或编码格式"));
      video.src = src;
      video.load();
    });
    await seekVideoLastFrame(video);
    return captureVideoFrame(video, path);
  } finally {
    video.pause(); video.removeAttribute("src"); video.load();
  }
}

/** One bounded decoder, only after the user loads the player. Dispose on close/switch. */
export function loadVideoStrip(src: string, duration: number, onFrame: (index: number, url: string) => void) {
  const decoder = document.createElement("video");
  decoder.crossOrigin = "anonymous";
  decoder.muted = true;
  decoder.preload = "none";
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 72;
  const context = canvas.getContext("2d");
  let index = 0, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    decoder.onloadeddata = decoder.onseeked = decoder.onerror = null;
    decoder.pause();
    decoder.removeAttribute("src");
    decoder.load();
  };
  const timeout = window.setTimeout(dispose, 20000);
  const next = () => { decoder.currentTime = Math.min(duration - 0.001, (index + 0.5) * duration / 12); };
  decoder.onloadeddata = () => { decoder.onloadeddata = null; next(); };
  decoder.onseeked = () => {
    if (disposed || !context) return;
    try {
      context.drawImage(decoder, 0, 0, canvas.width, canvas.height);
      onFrame(index, canvas.toDataURL("image/jpeg", 0.7));
      if (++index < 12) next(); else dispose();
    } catch { dispose(); } // The timeline remains usable without thumbnails.
  };
  decoder.onerror = dispose;
  decoder.src = src;
  decoder.load();
  return dispose;
}
