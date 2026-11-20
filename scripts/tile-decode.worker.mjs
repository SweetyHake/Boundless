/**
 * Boundless — Off-Main-Thread Image Tile Decoder Worker
 * Fetches WebP/PNG/JPG/AVIF tiles and decodes them into GPU-ready `ImageBitmap`
 * off the main thread, supporting in-flight cancellation via `AbortController`
 * and zero-copy transfer back to the main thread.
 */

/** @type {Map<number, AbortController>} */
const inflight = new Map();

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "cancel") {
    const ctrl = inflight.get(msg.id);
    if (ctrl) {
      inflight.delete(msg.id);
      try { ctrl.abort(); } catch {}
    }
    return;
  }

  if (msg.type !== "decode") return;
  const { id, url, premultiply } = msg;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  const t0 = performance.now();

  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      credentials: "same-origin",
      cache: "default"
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    if (ctrl.signal.aborted) {
      self.postMessage({ id, aborted: true });
      return;
    }

    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: premultiply === false ? "none" : "premultiply",
      colorSpaceConversion: "none"
    });

    if (ctrl.signal.aborted) {
      try { bitmap.close(); } catch {}
      self.postMessage({ id, aborted: true });
      return;
    }

    const decodeMs = performance.now() - t0;
    self.postMessage({ id, bitmap, decodeMs }, [bitmap]);
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === "AbortError") {
      self.postMessage({ id, aborted: true });
    } else {
      self.postMessage({ id, error: err?.message || String(err) });
    }
  } finally {
    inflight.delete(id);
  }
};
