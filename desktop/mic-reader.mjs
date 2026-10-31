// @audio/mic delivers ONE chunk per read(cb) call: the reader must ask again after each
// chunk. (Registering a callback once yields a single ~20 ms buffer and then silence.)
// This helper owns that loop so the capture code receives a continuous stream.

/**
 * @param {(cb: ((error: Error|null, chunk: Uint8Array|null) => void) | null) => void} reader
 *        the function returned by mic(); reader(null) stops capture
 * @param {{ onChunk: (chunk: Buffer) => void, onError: (error: Error) => void,
 *           retryDelayMs?: number, maxEmptyReads?: number }} handlers
 */
export function pumpReader(reader, { onChunk, onError, retryDelayMs = 10, maxEmptyReads = 300 }) {
  let active = true;
  let emptyReads = 0;
  let timer = null;

  const fail = (error) => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  const arm = () => {
    if (!active) return;
    try {
      reader(handle);
    } catch (error) {
      fail(error);
    }
  };

  function handle(error, chunk) {
    if (!active) return;
    if (error) return fail(error);
    if (chunk && chunk.length > 0) {
      emptyReads = 0;
      onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      arm();
      return;
    }
    // A momentary empty read is normal; a long run of them means the device is gone.
    emptyReads += 1;
    if (emptyReads > maxEmptyReads) {
      return fail(new Error('The microphone stream ended unexpectedly.'));
    }
    timer = setTimeout(arm, retryDelayMs);
  }

  arm();

  return {
    stop() {
      active = false;
      clearTimeout(timer);
      try { reader(null); } catch { /* device already closed */ }
    },
  };
}
