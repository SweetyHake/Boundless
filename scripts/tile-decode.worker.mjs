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
  const { id, url, premultiply, maxDim } = msg;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  const t0 = performance.now();

  let bitmap = null;
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      credentials: "same-origin",
      cache: "default"
    });
    if (!resp.ok) {
      if (resp.status === 404 || resp.status === 410) {
        self.postMessage({ id, notFound: true, error: `HTTP ${resp.status}` });
        return;
      }
      throw new Error(`HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    if (ctrl.signal.aborted) {
      self.postMessage({ id, aborted: true });
      return;
    }

    const decodeOpts = {
      premultiplyAlpha: premultiply === false ? "none" : "premultiply",
      colorSpaceConversion: "none"
    };
    bitmap = await createImageBitmap(blob, decodeOpts);

    if (maxDim > 0 && (bitmap.width > maxDim || bitmap.height > maxDim) && !ctrl.signal.aborted) {
      const ratio = maxDim / Math.max(bitmap.width, bitmap.height);
      const rw = Math.max(1, Math.round(bitmap.width * ratio));
      const rh = Math.max(1, Math.round(bitmap.height * ratio));
      try {
        const resized = await createImageBitmap(bitmap, {
          ...decodeOpts,
          resizeWidth: rw,
          resizeHeight: rh,
          resizeQuality: "high"
        });
        try { bitmap.close(); } catch {}
        bitmap = resized;
      } catch {}
    }

    if (ctrl.signal.aborted) {
      try { bitmap.close(); } catch {}
      bitmap = null;
      self.postMessage({ id, aborted: true });
      return;
    }

    const decodeMs = performance.now() - t0;
    const transferBmp = bitmap;
    bitmap = null;
    self.postMessage({ id, bitmap: transferBmp, decodeMs }, [transferBmp]);
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === "AbortError") {
      self.postMessage({ id, aborted: true });
    } else {
      self.postMessage({ id, error: err?.message || String(err) });
    }
  } finally {
    if (bitmap) {
      try { bitmap.close(); } catch {}
    }
    inflight.delete(id);
  }
};
