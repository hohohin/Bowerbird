export interface ReplicationSpeechInput { mime: "audio/wav"; base64: string; duration: number }
/** Accept only bounded mono PCM16/16k WAV made by the desktop, measuring the actual bytes. */
export function validateSpeechInput(value: unknown): asserts value is ReplicationSpeechInput {
  const v = value as ReplicationSpeechInput;
  if (!v || v.mime !== "audio/wav" || typeof v.base64 !== "string" || v.base64.length > 5_200_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.base64) || v.base64.length % 4
    || !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 120.2) throw new Error("语音识别仅接受两分钟内的 WAV 音频");
  const decode = (globalThis as unknown as { atob(input: string): string }).atob;
  const bytes = Uint8Array.from(decode(v.base64), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const tag = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) throw new Error("语音文件格式无效");
  let format = false, dataBytes = 0;
  for (let p = 12; p + 8 <= bytes.length;) {
    const n = view.getUint32(p + 4, true), start = p + 8;
    if (start + n > bytes.length) throw new Error("语音文件不完整");
    if (tag(p) === "fmt ") {
      if (n < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== 16000 || view.getUint32(start + 8, true) !== 32000
        || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw new Error("语音文件需为 16kHz 单声道 PCM16");
      format = true;
    }
    if (tag(p) === "data") dataBytes += n;
    p = start + n + (n % 2);
  }
  if (!format || !dataBytes || dataBytes % 2 || dataBytes / 32000 > 120.2 || Math.abs(dataBytes / 32000 - v.duration) > 0.25) throw new Error("语音实际时长与请求不符");
}
