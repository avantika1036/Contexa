import { isDurableMeetingKey } from './meeting-session.mjs';

const browserFamily = (processName) => !['zoom', 'zoomworkplace', 'zoommeetings', 'msteams', 'teams', 'webex', 'ciscocollabhost']
  .includes(String(processName || '').toLowerCase().replace(/\.exe$/, '').replace(/[\s_-]/g, ''));

/**
 * Google Meet sometimes starts with a generic "Meet" title and exposes its call code
 * shortly afterwards. Wait briefly before creating a database row so the first session
 * is normally created with the durable provider identity instead of browser:*.
 *
 * If the code appears later than this short window, main.mjs persists the identity upgrade
 * through the backend while keeping the current capture stream alive.
 */
export async function resolveStableMeetingWindow({
  initialWindow,
  getWindows,
  keyOf,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 2200,
  pollMs = 250,
}) {
  if (!initialWindow || typeof getWindows !== 'function' || typeof keyOf !== 'function') return initialWindow;
  const initialKey = keyOf(initialWindow);
  if (initialKey !== 'browser:*' || !browserFamily(initialWindow.processName)) return initialWindow;

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await sleepImpl(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    let windows = [];
    try { windows = await getWindows(); } catch { windows = []; }
    const sameProcess = (windows || []).filter((item) => item.pid === initialWindow.pid
      && String(item.processName || '').toLowerCase() === String(initialWindow.processName || '').toLowerCase());
    const identified = sameProcess.filter((item) => isDurableMeetingKey(keyOf(item)));
    if (identified.length === 1) return identified[0];
    if (identified.length > 1) {
      const foreground = identified.filter((item) => item.foreground);
      if (foreground.length === 1) return foreground[0];
      // Multiple explicit calls in one process without a clear foreground owner are
      // ambiguous; retain the provisional candidate instead of binding to the wrong call.
      return initialWindow;
    }
  }
  return initialWindow;
}
