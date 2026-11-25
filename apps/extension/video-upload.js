// Bounded, acknowledged video upload shared by the extension worker and page script.
(function (root) {
  "use strict";
  const S = root.BowerbirdCollection;
  const V = root.BowerbirdVideo;
  const CHUNK_BYTES = 1024 * 1024;

  async function streamResponse(response, support, metadata, signal, onReadComplete) {
    const limit = support.maxBytes;
    const body = response.body;
    if (!body) return { ok: false, code: "invalid_video" };

    let socket;
    let reader;
    let pending;
    let stopped;
    let committed = false;
    const stop = (code) => {
      if (stopped) return;
      stopped = Object.assign(new Error(code), { code });
      pending?.(stopped);
      void reader?.cancel().catch(() => {});
    };
    const onAbort = () => stop("fetch_timeout");
    const request = (timeout, send) => new Promise((resolve, reject) => {
      if (stopped) { reject(stopped); return; }
      const timer = setTimeout(() => stop("desktop_unavailable"), timeout);
      pending = (error, reply) => {
        pending = undefined;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(reply);
      };
      try { send?.(); }
      catch { stop("desktop_unavailable"); }
    });

    try {
      if (Number(response.headers.get("content-length")) > limit) return { ok: false, code: "too_large" };
      const access = await S.socketAccess();
      if (!access.ok) return access;
      signal?.throwIfAborted();
      signal?.addEventListener("abort", onAbort, { once: true });
      socket = S.openSocket(access.protocols);
      socket.onopen = () => pending?.(null);
      socket.onerror = socket.onclose = () => stop("desktop_unavailable");
      socket.onmessage = (event) => {
        try { pending?.(null, JSON.parse(event.data)); }
        catch { stop("invalid_receipt"); }
      };
      await request(S.UPLOAD_TIMEOUT_MS);
      const capabilities = (await request(S.UPLOAD_TIMEOUT_MS, () => socket.send(S.pingMessage())))?.capabilities;
      if (capabilities?.video_stream_upload !== true) return { ok: false, code: "desktop_upgrade" };

      // Native fetch streams can fill the same backing store in-place. A default
      // reader also works for other ReadableStreams (such as fixture responses).
      try { reader = body.getReader({ mode: "byob" }); }
      catch { /* Non-byte stream. */ }
      const byob = !!reader;
      reader ||= body.getReader();
      let buffer = new ArrayBuffer(CHUNK_BYTES);
      let source;
      let offset = 0;
      let total = 0;
      async function nextChunk() {
        let filled = 0;
        let chunk = new Uint8Array(buffer);
        while (filled < CHUNK_BYTES) {
          if (stopped) throw stopped;
          if (byob) {
            const { done, value } = await reader.read(chunk.subarray(filled));
            if (stopped) throw stopped;
            // BYOB reads transfer ownership of the buffer into the result.
            chunk = new Uint8Array(value.buffer);
            filled += value.byteLength;
            if (total + filled > limit) throw Object.assign(new Error("Video exceeds byte limit"), { code: "too_large" });
            if (done) break;
            continue;
          }
          if (!source || offset === source.byteLength) {
            const result = await reader.read();
            if (stopped) throw stopped;
            if (result.done) break;
            source = result.value;
            offset = 0;
            if (total + filled + source.byteLength > limit) {
              throw Object.assign(new Error("Video exceeds byte limit"), { code: "too_large" });
            }
          }
          const length = Math.min(chunk.length - filled, source.byteLength - offset);
          chunk.set(source.subarray(offset, offset + length), filled);
          offset += length;
          filled += length;
        }
        buffer = chunk.buffer;
        return chunk.subarray(0, filled);
      }

      let bytes = await nextChunk();
      if (V.stream(bytes)) return { ok: false, code: "unsupported_stream" };
      const ext = V.format(bytes);
      if (!ext) return { ok: false, code: "invalid_video" };
      const started = await request(S.UPLOAD_TIMEOUT_MS, () => socket.send(JSON.stringify({
        ...metadata, type: "save_blob_start", file_name: `video.${ext}`,
      })));
      if (!started?.ok || started.received !== 0) return started?.ok === false ? started : { ok: false, code: "invalid_receipt" };

      while (bytes.byteLength) {
        total += bytes.byteLength;
        // Wait until the desktop writes this chunk before pulling the next one.
        const ack = await request(S.UPLOAD_TIMEOUT_MS, () => socket.send(bytes));
        if (!ack?.ok || ack.received !== total) return ack?.ok === false ? ack : { ok: false, code: "invalid_receipt" };
        bytes = await nextChunk();
      }
      onReadComplete?.();
      const final = await request(S.VIDEO_UPLOAD_TIMEOUT_MS, () => {
        socket.send(JSON.stringify({ type: "save_blob_end", byte_length: total }));
        committed = true;
      });
      if (final?.ok === false || (final?.ok === true && final.media_kind === "video")) return final;
      return { ok: false, code: "result_unknown" };
    } catch (error) {
      return { ok: false, code: committed ? "result_unknown" : error?.code || (error?.name === "AbortError" ? "fetch_timeout" : "fetch_failed") };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      void (reader ?? body).cancel().catch(() => {});
      socket?.close();
    }
  }

  root.BowerbirdVideoUpload = { streamResponse };
})(globalThis);
