/**
 * Device-selection and retry policy for Windows microphone hot-plug recovery.
 * Device IDs come directly from @audio/mic's devices() API; never synthesize IDs.
 */
export function selectMicrophoneDevice(devices, preferredDeviceId = null) {
  if (!Array.isArray(devices)) return null;
  const usable = devices.filter((device) => device
    && typeof device.id === 'string'
    && device.id.length > 0
    && typeof device.name === 'string'
    && device.name.length > 0);

  // Follow the Windows default first: inserting a headset can change the default
  // input endpoint while the previous WASAPI endpoint is being invalidated.
  const defaultDevice = usable.find((device) => device.default === true);
  if (defaultDevice) return defaultDevice;

  // If Windows has not changed the default, retain the existing endpoint when it
  // is still enumerated. This avoids switching microphones unnecessarily.
  if (preferredDeviceId) {
    const preferred = usable.find((device) => device.id === preferredDeviceId);
    if (preferred) return preferred;
  }

  // A single remaining input is unambiguous even if the host omitted its default flag.
  return usable.length === 1 ? usable[0] : null;
}

export function isRecoverableMicrophoneDeviceError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'EDEVICELOST' || code === 'ENODEVICE') return true;
  return /\b(?:input|microphone|audio)\b.{0,32}\b(?:device|endpoint)\b.{0,32}\b(?:stopped|unplugged|invalidated|unavailable)\b/i.test(String(error?.message || ''));
}

export function microphoneRetryDelayMs(attempt) {
  const delays = [500, 1000, 2000, 4000, 5000];
  const index = Math.max(0, Math.min(delays.length - 1, Math.floor(Number(attempt) || 0)));
  return delays[index];
}


/**
 * Windows may publish the new default input endpoint slightly after the old endpoint
 * raises EDEVICELOST. Require the selected default to be stable across consecutive
 * enumerations before reopening it, avoiding an immediate reopen of a transient endpoint.
 */
export async function waitForStableMicrophoneDevice({
  listDevices,
  preferredDeviceId = null,
  attempts = 6,
  requiredConsecutive = 2,
  intervalMs = 350,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof listDevices !== 'function') return null;
  let previousId = null;
  let consecutive = 0;
  let lastSelected = null;
  const total = Math.max(1, Math.floor(attempts));
  const required = Math.max(1, Math.floor(requiredConsecutive));

  for (let index = 0; index < total; index += 1) {
    let devices = [];
    try { devices = await listDevices(); } catch { devices = []; }
    const selected = selectMicrophoneDevice(devices, preferredDeviceId);
    if (!selected) {
      previousId = null;
      consecutive = 0;
      lastSelected = null;
    } else {
      lastSelected = selected;
      if (selected.id === previousId) consecutive += 1;
      else { previousId = selected.id; consecutive = 1; }
      if (consecutive >= required) return selected;
    }
    if (index < total - 1) await sleepImpl(intervalMs);
  }
  // No candidate stayed selected long enough; let the caller retry rather than
  // reopening a transient endpoint during Windows audio-route reconfiguration.
  return null;
}
