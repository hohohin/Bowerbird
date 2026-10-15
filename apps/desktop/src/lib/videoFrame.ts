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
