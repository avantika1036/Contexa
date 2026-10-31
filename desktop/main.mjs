import { app, dialog, Menu, nativeImage, Tray, shell, BrowserWindow, ipcMain } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import loopback from 'loopback-capture';
import mic from '@audio/mic';
import { startUiServer } from './ui-server.mjs';
import { meetingKey, classifyWindowTransition, SessionContinuity, graceForKey } from './meeting-session.mjs';
import { createMeetingSession, resumeMeetingSession, suspendMeetingSession } from './meeting-api.mjs';
import { pumpReader } from './mic-reader.mjs';
import { captureStopReason, selectStartCandidate, resolveAutoCapture } from './capture-policy.mjs';
import { FramePacer } from './frame-pacer.mjs';
import { SampleQueue } from './sample-queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROOT_ENV = path.join(PROJECT_ROOT, '.env');
if (existsSync(ROOT_ENV)) dotenv.config({ path: ROOT_ENV });
const DEV_WORKSPACE_URL = process.env.CONTEXA_DEV_UI_URL || 'http://127.0.0.1:5173';
const UI_HOST = '127.0.0.1';
const UI_PORT = Number(process.env.CONTEXA_UI_PORT || 4173);
let WORKSPACE_URL = `http://${UI_HOST}:${UI_PORT}/?desktop=1`;

const API_BASE = (process.env.CONTEXA_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const WS_BASE = API_BASE.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
const POLL_MS = 2500;
const STOP_AFTER_MISSING_MS = Math.max(5, Number(process.env.CONTEXA_STOP_AFTER_MISSING_SECONDS || 15)) * 1000;
// After capture stops, the session stays open this long so the same meeting can resume in it
// (tab switch, window recreated, brief disconnect) instead of creating a duplicate session.
// Capture stops when no one has been audible for this long (the meeting page may still be open,
// e.g. "You left the meeting"). 0 disables idle ending.
const IDLE_END_MS = Math.max(0, Number(process.env.CONTEXA_IDLE_END_SECONDS ?? 180)) * 1000;
// After an idle stop, the same still-open page may not restart capture for this long.
const IDLE_RESTART_BLOCK_MS = Math.max(0, Number(process.env.CONTEXA_IDLE_RESTART_BLOCK_SECONDS ?? 600)) * 1000;
// Zoom/Teams/Webex windows closing normally means the call is over, so those end sooner.
const NATIVE_SESSION_GRACE_MS = Math.max(0, Number(process.env.CONTEXA_NATIVE_SESSION_GRACE_SECONDS ?? 60)) * 1000;
const CAPTURE_POLICY = { stopAfterMissingMs: STOP_AFTER_MISSING_MS, idleEndMs: IDLE_END_MS };
const SESSION_GRACE_MS = Math.max(0, Number(process.env.CONTEXA_SESSION_GRACE_SECONDS || 300)) * 1000;
const PCM_RATE = 48000;
const OUTPUT_FRAME_MS = 100;
const MIXER_TICK_MS = 20;
const FRAME_SAMPLES = PCM_RATE * OUTPUT_FRAME_MS / 1000;
const CAPTURED_PROCESS_NAMES = new Set([
  'zoom', 'zoomworkplace', 'zoom meetings', 'ms-teams', 'teams', 'webex',
  'ciscocollabhost', 'chrome', 'msedge', 'brave', 'firefox',
]);

let tray;
let mainWindow = null;
let uiServer = null;
let isQuitting = false;
let shutdownInProgress = false;
let shutdownComplete = false;
let settings = { autoCaptureEnabled: false, consentVersion: 0, firstRunPromptSeen: false, autoCapturePausedByUser: false };
let currentCapture = null;
let monitorTimer = null;
let monitorInFlight = false;
let lastCaptureError = '';
let lastStartAttemptKey = '';
let lastStartAttemptAt = 0;
let serviceBootstrapPromise = null;
let migrationPromise = null;
let migrationsApplied = false;
const continuity = new SessionContinuity({ graceMs: SESSION_GRACE_MS });
let finalizeTimer = null;
let restartBlock = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpOk(url, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(url, 1500)) return true;
    await sleep(800);
  }
  return false;
}

async function ensureLocalMigrations() {
  if (migrationsApplied) return true;
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const backendDir = path.join(PROJECT_ROOT, 'backend');
    const pythonPath = path.join(backendDir, '.venv', 'Scripts', 'python.exe');
    if (!existsSync(pythonPath)) {
      await dialog.showMessageBox({
        type: 'error', title: 'Contexa backend is not installed',
        message: 'The backend Python environment is missing, so database updates cannot be checked.',
        detail: `Expected ${pythonPath}. Run Start-Contexa.ps1 once to set up the backend.`,
      });
      return false;
    }
    try {
      const { stdout, stderr } = await execFileAsync(pythonPath, ['-m', 'alembic', 'upgrade', 'head'], {
        cwd: backendDir, windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024,
      });
      if (stdout.trim()) console.info('Database migration output:', stdout.trim());
      if (stderr.trim()) console.info('Database migration notes:', stderr.trim());
      migrationsApplied = true;
      console.info('Contexa database schema is up to date.');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Could not apply Contexa database migrations:', message);
      await dialog.showMessageBox({
        type: 'error', title: 'Contexa database update failed',
        message: 'Contexa could not apply its additive database migrations.',
        detail: `${message}\n\nYour database volume was not reset. Check backend/.venv, DATABASE_URL and the Alembic revision in the existing database.`,
      });
      return false;
    }
  })().finally(() => { migrationPromise = null; });
  return migrationPromise;
}

function spawnHidden(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: Boolean(options.shell),
  });
  child.once('error', (error) => console.error(`Could not start ${command}:`, error.message));
  child.unref();
  return child;
}

async function ensureLocalServices() {
  // Remote deployments should be managed by their owner; this helper only bootstraps
  // the local development stack bundled with the repository.
  let apiUrl;
  try { apiUrl = new URL(API_BASE); } catch { return false; }
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname);
  if (!isLocal) return await httpOk(`${API_BASE}/health/db`);
  if (await httpOk(`${API_BASE}/health/db`)) return ensureLocalMigrations();

  if (!serviceBootstrapPromise) {
    serviceBootstrapPromise = (async () => {
      try {
        await execFileAsync('docker.exe', ['compose', 'up', '-d', 'postgres'], {
          cwd: PROJECT_ROOT, windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Could not start the local PostgreSQL container:', message);
        await dialog.showMessageBox({
          type: 'error', title: 'Contexa database is not running',
          message: 'Contexa could not start PostgreSQL automatically.',
          detail: 'Open Docker Desktop and ensure Docker Compose is available. Your existing database volume is left untouched. Error: ' + message,
        });
        return false;
      }

      const pythonPath = path.join(PROJECT_ROOT, 'backend', '.venv', 'Scripts', 'python.exe');
      if (!(await httpOk(`${API_BASE}/health`))) {
        if (!existsSync(pythonPath)) {
          await dialog.showMessageBox({
            type: 'error', title: 'Contexa backend is not installed',
            message: 'The backend virtual environment was not found.',
            detail: `Expected ${pythonPath}. Run Start-Contexa.ps1 once to set up the backend, then reopen Contexa.`,
          });
          return false;
        }
        const port = apiUrl.port || (apiUrl.protocol === 'https:' ? '443' : '80');
        spawnHidden(pythonPath, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port], {
          cwd: path.join(PROJECT_ROOT, 'backend'),
        });
      }

      if (!(await waitForHttp(`${API_BASE}/health/db`, 60000))) {
        await dialog.showMessageBox({
          type: 'error', title: 'Contexa backend did not become ready',
          message: 'The API/database did not respond after startup.',
          detail: 'Check PostgreSQL, backend/.venv and the backend terminal/log. Contexa will not capture audio until the backend is reachable.',
        });
        return false;
      }

      return ensureLocalMigrations();
    })().finally(() => { serviceBootstrapPromise = null; });
  }
  return serviceBootstrapPromise;
}

async function startFrontendServer() {
  if (uiServer) return true;
  const distRoot = path.resolve(PROJECT_ROOT, 'frontend', 'dist');
  uiServer = await startUiServer({ distRoot, host: UI_HOST, port: UI_PORT });
  return true;
}

async function ensureFrontendRunning() {
  // The default path serves the compiled React bundle from inside Electron. The browser
  // is never opened as a separate app. Vite is opt-in for development only.
  if (process.env.CONTEXA_DEV_UI === 'true') {
    WORKSPACE_URL = `${DEV_WORKSPACE_URL.replace(/\/$/, '')}/?desktop=1`;
    if (await httpOk(WORKSPACE_URL)) return true;
    const frontendDir = path.join(PROJECT_ROOT, 'frontend');
    if (!existsSync(path.join(frontendDir, 'node_modules', 'vite'))) {
      await dialog.showMessageBox({
        type: 'error', title: 'Contexa development UI is unavailable',
        message: 'The Vite development server is not installed.',
        detail: 'Run npm ci in the frontend folder, or unset CONTEXA_DEV_UI to use the compiled desktop UI.',
      });
      return false;
    }
    spawnHidden('cmd.exe', ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1'], { cwd: frontendDir });
    return await waitForHttp(WORKSPACE_URL, 20000);
  }

  try {
    await startFrontendServer();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox({
      type: 'error', title: 'Contexa desktop UI could not start',
      message: 'The compiled React interface is missing or its local server could not start.',
      detail: `${message}\n\nRun desktop\\setup-and-run.ps1 to install dependencies and build the UI.`,
    });
    return false;
  }
}

async function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  }
  if (!(await ensureFrontendRunning())) return false;

  const windowIconPath = path.join(__dirname, 'assets', 'contexa.ico');
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: 'Contexa',
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    icon: existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(WORKSPACE_URL.split('?')[0])) void shell.openExternal(url);
    return { action: 'deny' };
  });
  try {
    await mainWindow.loadURL(WORKSPACE_URL);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox({ type: 'error', title: 'Contexa could not open', message, detail: 'The desktop window could not load the local interface.' });
    mainWindow?.destroy();
    mainWindow = null;
    return false;
  }
}

function startMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (!settings.autoCaptureEnabled) return;
  monitorTimer = setInterval(() => void monitorMeetingWindows(), POLL_MS);
  void monitorMeetingWindows();
}

function stopMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    // First launch uses safe defaults: automatic capture is off until the user opts in.
  }
}

async function saveSettings() {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function setStartupEnabled(enabled) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: true,
    path: process.execPath,
    args: [__dirname],
  });
}

function titleLooksLikeMeeting(processName, title) {
  const process = String(processName || '').toLowerCase().replace(/\.exe$/, '').trim();
  const name = String(title || '').trim();
  const lower = name.toLowerCase();
  if (!name || !CAPTURED_PROCESS_NAMES.has(process)) return false;

  // Require a meeting/call title or a recognizable web meeting title. Merely opening
  // Zoom, Teams, a browser, or an unrelated media app must not start microphone capture.
  if (['zoom', 'zoomworkplace', 'zoom meetings'].includes(process)) {
    return /\bzoom\s+meeting\b|\bmeeting\b.*\bzoom\b|\bcall\b.*\bzoom\b|\bzoom\b.*\bcall\b/i.test(name)
      && !/home|settings|contacts|chat|schedule/i.test(lower);
  }
  if (['ms-teams', 'teams'].includes(process)) {
    return /\bmeeting\b|\bcall\b|\bhuddle\b/i.test(name)
      && /teams|meeting|call|huddle/i.test(lower)
      && !/settings|chat list|activity/i.test(lower);
  }
  if (['webex', 'ciscocollabhost'].includes(process)) {
    return /\bmeeting\b|\bcall\b|\bwebex\b/i.test(name)
      && !/home|settings|chat|calendar/i.test(lower);
  }
  // Browser windows: support the standard meeting titles shown by Meet, Zoom Web,
  // Teams and Webex. The agent targets the browser process tree, not system audio.
  return /google meet|meet\s*[-–|].*chrome|meet\s*[-–|].*edge|meet\.google|zoom meeting|zoom\.us.*meeting|meeting.*zoom|microsoft teams.*meeting|meeting.*microsoft teams|teams\.microsoft|webex.*meeting|meeting.*webex/i.test(name)
    && !/settings|extensions|history|downloads/i.test(lower);
}

async function getMeetingWindows() {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ContexaWindowFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
[uint32]$foregroundPid = 0
$foregroundHandle = [ContexaWindowFocus]::GetForegroundWindow()
if ($foregroundHandle -ne [IntPtr]::Zero) { [void][ContexaWindowFocus]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) }
$rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.Id; processName = [string]$_.ProcessName; title = [string]$_.MainWindowTitle; foreground = ([int]$_.Id -eq [int]$foregroundPid) }
})
ConvertTo-Json -InputObject $rows -Compress
`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const content = stdout.trim();
    if (!content) return [];
    const parsed = JSON.parse(content);
    const windows = Array.isArray(parsed) ? parsed : [parsed];
    return windows
      .filter((window) => Number.isInteger(Number(window.pid)) && titleLooksLikeMeeting(window.processName, window.title))
      .map((window) => ({
        pid: Number(window.pid),
        processName: String(window.processName),
        title: String(window.title).replace(/\s+-\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave)$/i, '').trim().slice(0, 180),
        foreground: Boolean(window.foreground),
      }))
      .sort((left, right) => Number(right.foreground) - Number(left.foreground));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastCaptureError) {
      console.error('Could not inspect meeting windows:', message);
      lastCaptureError = message;
    }
    return [];
  }
}


function stereoPcmToMono(buffer) {
  const frameBytes = 4; // s16le, two channels
  const frames = Math.floor(buffer.length / frameBytes);
  const mono = new Int16Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const left = buffer.readInt16LE(index * frameBytes);
    const right = buffer.readInt16LE(index * frameBytes + 2);
    mono[index] = Math.round((left + right) / 2);
  }
  return mono;
}

function monoPcmBufferToSamples(buffer) {
  const count = Math.floor(buffer.length / 2);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = buffer.readInt16LE(index * 2);
  return samples;
}

function createStereoFrame(appQueue, micQueue) {
  const appSamples = appQueue.pull(FRAME_SAMPLES);
  const micSamples = micQueue.pull(FRAME_SAMPLES);
  // Keep source provenance intact: left channel = meeting-process audio;
  // right channel = microphone. This lets Deepgram distinguish the local
  // participant from remote speakers instead of guessing from one mono mix.
  const output = Buffer.allocUnsafe(FRAME_SAMPLES * 4);
  for (let index = 0; index < FRAME_SAMPLES; index += 1) {
    const appSample = Math.round(appSamples[index] * 0.9);
    const micSample = Math.round(micSamples[index] * 0.85);
    const offset = index * 4;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, appSample)), offset);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, micSample)), offset + 2);
  }
  return output;
}

function channelHasAudioActivity(buffer, channelIndex) {
  const sampleCount = Math.floor(buffer.length / 4);
  if (!sampleCount) return false;
  let sumSquares = 0;
  let peak = 0;
  const channelOffset = channelIndex === 0 ? 0 : 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const absolute = Math.abs(buffer.readInt16LE(index * 4 + channelOffset));
    peak = Math.max(peak, absolute);
    sumSquares += absolute * absolute;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms >= 145 || (rms >= 65 && peak >= 900);
}

async function endMeetingSession(meetingId, { discardIfEmpty = true } = {}) {
  const query = discardIfEmpty ? '?discard_if_empty=true' : '';
  try {
    await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(meetingId)}/end${query}`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.error(`Could not end Contexa session ${meetingId}:`, error);
  }
}

async function suspendMeeting(meetingId) {
  try {
    await suspendMeetingSession({ apiBase: API_BASE, meetingId });
    console.info(`Session ${meetingId} is suspended and can be resumed during the recovery window.`);
    return true;
  } catch (error) {
    // Leaving the row active is safer than ending a possibly live meeting. The auto
    // endpoint can still recover it after an abrupt app/process exit.
    console.warn(`Could not persist suspension for Contexa session ${meetingId}:`, error?.message || error);
    return false;
  }
}

async function finalizePendingSession(reason) {
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  const pending = continuity.release();
  if (!pending) return;
  console.info(`Ending session ${pending.meetingId} (${reason}).`);
  await endMeetingSession(pending.meetingId);
}

function deferSessionEnd({ meetingId, key, title, pid = null }) {
  const graceMs = graceForKey(key, { browserMs: SESSION_GRACE_MS, nativeMs: NATIVE_SESSION_GRACE_MS });
  const superseded = continuity.defer({ meetingId, key, title, pid, graceMs });
  if (superseded) void endMeetingSession(superseded.meetingId);
  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => { void finalizePendingSession('grace period elapsed'); }, graceMs + 1000);
  console.info(`Session ${meetingId} (${key}) stays open for ${Math.round(graceMs / 1000)}s in case the same meeting resumes.`);
}

async function runSessionCleanup() {
  try {
    const response = await fetch(`${API_BASE}/api/meetings/cleanup`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    if (response.ok) console.info('Session cleanup:', JSON.stringify(await response.json()));
  } catch (error) {
    console.warn('Session cleanup skipped:', error?.message || error);
  }
}

async function createMeeting(title, sessionKey, processName) {
  const meeting = await createMeetingSession({ apiBase: API_BASE, title, sessionKey, processName });
  if (meeting.durable_identity_fallback) {
    const warning = 'The running FastAPI process does not expose /api/meetings/auto (HTTP 404/405). Contexa created a compatibility session so capture can continue, but database-backed duplicate prevention is unavailable until the older backend process is stopped and Contexa is restarted.';
    console.warn(warning);
    tray?.displayBalloon?.({ title: 'Contexa backend needs restarting', content: 'Meeting capture can continue, but durable session deduplication is unavailable until the updated FastAPI backend is loaded. Restart Contexa when this meeting ends.' });
  }
  return meeting;
}

function connectMeetingSocket(meetingId) {
  const socket = new WebSocket(`${WS_BASE}/ws/meeting/${encodeURIComponent(meetingId)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting the auto-capture stream to Contexa.')), 12000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForTranscriptionReady(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Deepgram did not confirm the streaming session within 15 seconds. Check DEEPGRAM_API_KEY and backend logs.')), 15000);
    const handler = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'transcription.ready') {
        clearTimeout(timer);
        socket.off('message', handler);
        resolve();
      } else if (message.type === 'transcription.error' || message.type === 'error') {
        clearTimeout(timer);
        socket.off('message', handler);
        reject(new Error(message.message || 'Transcription did not start.'));
      }
    };
    socket.on('message', handler);
  });
}

async function startCaptureForWindow(windowInfo) {
  if (currentCapture) return;
  const title = windowInfo.title || `${windowInfo.processName} meeting`;
  const sessionKey = meetingKey(windowInfo.processName, title);
  let reusedSession = false;
  let meeting;
  let socket;
  let loopbackCapture;
  let micReader;
  let micPump = null;
  let mixerTimer;
  let micFailure = null;
  let micReading = true;
  const appQueue = new SampleQueue(PCM_RATE * 3);
  const micQueue = new SampleQueue(PCM_RATE * 3);
  const audioStats = { forwardedFrames: 0, suppressedSilentFrames: 0, appActiveFrames: 0, micActiveFrames: 0, micBacklogMs: 0, micDroppedMs: 0, appDroppedMs: 0, lastAudibleAt: 0 };

  const stopMicReader = () => {
    micReading = false;
    try { if (micPump) micPump.stop(); else micReader?.(null); } catch (error) { console.warn('Microphone shutdown warning:', error); }
  };

  const handleMicError = (error) => {
    if (!micReading) return;
    micFailure = error;
    micReading = false;
    console.error('Microphone capture error:', error);
    if (currentCapture?.processId === windowInfo.pid) {
      tray?.displayBalloon?.({ title: 'Contexa microphone unavailable', content: 'Auto Capture stopped because the microphone could not be read. Check Windows microphone privacy settings and input devices.' });
      void stopCapture('Microphone input failed; stopping rather than silently omitting your voice');
    }
  };

  const handleMicChunk = (chunk) => {
    if (micReading) micQueue.push(monoPcmBufferToSamples(chunk));
  };

  try {
    const claimed = continuity.claim(sessionKey, { pid: windowInfo.pid });
    if (claimed) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
      try {
        await resumeMeetingSession({ apiBase: API_BASE, meetingId: claimed.meetingId });
        meeting = { id: claimed.meetingId };
        reusedSession = true;
        console.info(`Resumed existing session ${claimed.meetingId} for "${title}" instead of creating a new one.`);
      } catch (resumeError) {
        if (![404, 409].includes(resumeError?.status)) throw resumeError;
        console.warn(`The deferred session ${claimed.meetingId} is no longer resumable; obtaining a valid session for ${sessionKey}.`);
        meeting = await createMeeting(title, sessionKey, windowInfo.processName);
        reusedSession = Boolean(meeting.reused_by_server);
      }
    } else {
      // A different meeting is starting: close whatever was waiting, then start fresh.
      await finalizePendingSession('a different meeting started');
      meeting = await createMeeting(title, sessionKey, windowInfo.processName);
      reusedSession = Boolean(meeting.reused_by_server);
      if (reusedSession) {
        console.info(`The backend returned existing active session ${meeting.id} for stable meeting identity ${sessionKey}.`);
      }
    }
    socket = await connectMeetingSocket(meeting.id);
    // A silently dead connection used to leave capture running with nothing transcribed. Stop,
    // and let the monitor restart capture in the SAME session shortly afterwards.
    const openedSocket = socket;
    openedSocket.on('close', (code) => {
      if (currentCapture?.socket !== openedSocket || currentCapture.stopping) return;
      console.warn(`Contexa transcription connection closed unexpectedly (code ${code}); reconnecting to the same session.`);
      lastStartAttemptAt = Date.now() - 20_000; // allow a restart on the next polls
      void stopCapture('The Contexa transcription connection closed unexpectedly');
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'transcript.segment') {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('contexa:transcript', message);
        }
        if (message.is_final && message.segment?.text) {
          const source = message.segment.audio_channel === 1 ? 'you/microphone' : `meeting speaker ${Number(message.segment.speaker_id ?? 0) + 1}`;
          console.info(`[${title}] ${source}: ${message.segment.text}`);
        }
      } else if (message.type === 'transcription.error') {
        lastCaptureError = String(message.message || 'Deepgram reported a transcription error.');
        console.error('Transcription provider error:', message.message);
      }
    });
    socket.send(JSON.stringify({
      type: 'audio.start',
      source: 'desktop_auto',
      audio_format: 'linear16',
      sample_rate: PCM_RATE,
      channels: 2,
      multichannel: true,
      mime_type: 'audio/pcm;encoding=linear16;rate=48000;channels=2;left=meeting;right=microphone',
    }));
    await waitForTranscriptionReady(socket);

    // Capture only the detected meeting process tree (not OS-wide playback), plus
    // the user's microphone. Both sources remain separate in stereo PCM.
    loopbackCapture = new loopback.LoopbackCapture();
    loopbackCapture.start(windowInfo.pid, true, (chunk) => {
      if (Buffer.isBuffer(chunk)) appQueue.push(stereoPcmToMono(chunk));
    });

    micReader = mic({ sampleRate: PCM_RATE, channels: 1, bitDepth: 16, backend: 'miniaudio', bufferSize: 50 });
    // @audio/mic returns one chunk per read() call, so pumpReader asks again after every chunk.
    micPump = pumpReader(micReader, { onChunk: handleMicChunk, onError: handleMicError });
    console.info(`Microphone reader started (backend=${micReader.backend || 'default'}, requested_rate=${PCM_RATE} Hz).`);

    // Wait for real mic buffers, not merely for the device object to be created.
    // A capture session must never silently run without the user's voice channel.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && micQueue.totalSamples < FRAME_SAMPLES && !micFailure) {
      await sleep(100);
    }
    if (micFailure) throw new Error(`Could not open/read the microphone: ${micFailure.message || micFailure}. Check Windows microphone privacy settings and input devices.`);
    if (micQueue.totalSamples < FRAME_SAMPLES) {
      throw new Error('The microphone opened but produced no audio buffers within 4 seconds. Check Windows Settings > Privacy & security > Microphone, your selected input device, and whether another app has exclusive control.');
    }
    if (socket.readyState !== WebSocket.OPEN) throw new Error('The transcription WebSocket closed before capture started.');
    if (appQueue.totalSamples < FRAME_SAMPLES) {
      console.warn(`Meeting process audio has not produced a full buffer yet (PID ${windowInfo.pid}). Capture is starting with mic channel only until the app begins rendering audio.`);
    }

    // 700 ms of audio time (not wall-clock time) after the last audible frame is still forwarded,
    // so Deepgram sees the pause it needs to finalize the sentence.
    const SILENCE_TAIL_FRAMES = 7;
    let framesSinceAudible = Infinity;
    const emitFrame = () => {
      const frame = createStereoFrame(appQueue, micQueue);
      const appActive = channelHasAudioActivity(frame, 0);
      const micActive = channelHasAudioActivity(frame, 1);
      if (appActive) audioStats.appActiveFrames += 1;
      if (micActive) audioStats.micActiveFrames += 1;
      if (appActive || micActive) {
        framesSinceAudible = 0;
        audioStats.lastAudibleAt = Date.now();
      } else {
        framesSinceAudible += 1;
      }
      // Preserve active speech and a short tail, while suppressing long silent periods.
      if (framesSinceAudible >= SILENCE_TAIL_FRAMES) {
        audioStats.suppressedSilentFrames += 1;
        return;
      }
      audioStats.forwardedFrames += 1;
      socket.send(frame, { binary: true }, (error) => {
        if (error) {
          lastCaptureError = `Could not send audio to Contexa: ${error.message}`;
          console.error(lastCaptureError);
        }
      });
      if (audioStats.forwardedFrames % 500 === 0) {
        console.info(`Audio channel activity: forwarded=${audioStats.forwardedFrames}, meeting_audio_active=${audioStats.appActiveFrames}, microphone_active=${audioStats.micActiveFrames}, mic_backlog_ms=${Math.round(audioStats.micBacklogMs)}, mic_dropped_ms=${Math.round(audioStats.micDroppedMs)}, meeting_dropped_ms=${Math.round(audioStats.appDroppedMs)}`);
      }
    };

    // Pace output against a monotonic clock. A plain setInterval(100) fires about every 109 ms on
    // Windows, which let the microphone backlog grow (late transcripts) until audio was dropped.
    const pacer = new FramePacer({ frameMs: OUTPUT_FRAME_MS });
    pacer.start();
    mixerTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      let frames = pacer.due();
      // Drain any residual backlog (for example after an event-loop stall) a little faster than real time.
      if (micQueue.totalSamples > FRAME_SAMPLES * 3 || appQueue.totalSamples > FRAME_SAMPLES * 3) frames += 1;
      for (let remaining = frames; remaining > 0; remaining -= 1) emitFrame();
      audioStats.micBacklogMs = (micQueue.totalSamples / PCM_RATE) * 1000;
      audioStats.micDroppedMs = (micQueue.droppedSamples / PCM_RATE) * 1000;
      audioStats.appDroppedMs = (appQueue.droppedSamples / PCM_RATE) * 1000;
    }, MIXER_TICK_MS);

    currentCapture = {
      meetingId: meeting.id,
      sessionKey,
      title,
      processId: windowInfo.pid,
      processName: windowInfo.processName,
      startedAt: Date.now(),
      lastMatchedAt: Date.now(),
      socket,
      loopbackCapture,
      micReader,
      stopMicReader,
      mixerTimer,
      audioStats,
      stopping: false,
    };
    lastCaptureError = '';
    console.info(`Automatic meeting capture started: ${title} (PID ${windowInfo.pid}); stereo channel 0=meeting audio, channel 1=local microphone; raw audio is not stored.`);
    tray?.displayBalloon?.({ title: 'Contexa is capturing a meeting', content: `${title}\nMeeting audio and your microphone are transcribed on separate channels. Raw audio is not saved.` });
    updateTrayMenu();
  } catch (error) {
    console.error('Could not start automatic meeting capture:', error);
    clearInterval(mixerTimer);
    stopMicReader();
    try { loopbackCapture?.stop(); } catch { /* best-effort cleanup */ }
    try { socket?.close(); } catch { /* best-effort cleanup */ }
    if (meeting?.id) {
      await sleep(500);
      if (reusedSession) {
        // Keep the original session recoverable for the next attempt.
        await suspendMeeting(meeting.id);
        deferSessionEnd({ meetingId: meeting.id, key: sessionKey, title, pid: windowInfo.pid });
      } else {
        // A failed start must not leave an empty session in the meeting history.
        await endMeetingSession(meeting.id, { discardIfEmpty: true });
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    lastCaptureError = message;
    tray?.displayBalloon?.({ title: 'Contexa could not start capture', content: message });
    updateTrayMenu();
  }
}

async function stopCapture(reason = 'Meeting window disappeared', { endNow = false, suspendOnly = false } = {}) {
  const capture = currentCapture;
  if (!capture || capture.stopping) return;
  capture.stopping = true;
  currentCapture = null;
  clearInterval(capture.mixerTimer);
  try { capture.stopMicReader?.(); } catch (error) { console.warn('Microphone shutdown warning:', error); }
  try { capture.loopbackCapture?.stop(); } catch (error) { console.warn('Loopback shutdown warning:', error); }

  if (capture.socket?.readyState === WebSocket.OPEN) {
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(); }, 7000);
        const handler = (data, isBinary) => {
          if (isBinary) return;
          let message;
          try { message = JSON.parse(data.toString()); } catch { return; }
          if (message.type === 'message.received' && message.message_type === 'audio.stop') {
            cleanup();
            resolve();
          }
        };
        const cleanup = () => { clearTimeout(timer); capture.socket.off('message', handler); };
        capture.socket.on('message', handler);
        capture.socket.send(JSON.stringify({ type: 'audio.stop', source: 'desktop_auto' }));
      });
      await new Promise((resolve) => {
        if (capture.socket.readyState === WebSocket.CLOSED) return resolve();
        const timer = setTimeout(() => {
          try { capture.socket.terminate(); } catch { /* best effort */ }
          resolve();
        }, 2000);
        capture.socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try { capture.socket.close(1000, 'Auto-capture stopped'); } catch {
          clearTimeout(timer);
          try { capture.socket.terminate(); } catch { /* best effort */ }
          resolve();
        }
      });
    } catch (error) {
      console.warn('Could not wait for final Deepgram transcript flush:', error);
      try { capture.socket.terminate(); } catch { /* best effort */ }
    }
  } else {
    try { capture.socket?.terminate(); } catch { /* best effort */ }
  }

  await sleep(500);
  if (endNow) {
    await endMeetingSession(capture.meetingId, { discardIfEmpty: true });
  } else {
    await suspendMeeting(capture.meetingId);
    if (!suspendOnly) {
      deferSessionEnd({ meetingId: capture.meetingId, key: capture.sessionKey, title: capture.title, pid: capture.processId });
    }
  }
  console.info(`Automatic meeting capture stopped: ${capture.title}. Reason: ${reason}. Audio stats: ${JSON.stringify(capture.audioStats || {})}`);
  updateTrayMenu();
}

async function monitorMeetingWindows() {
  if (monitorInFlight || !settings.autoCaptureEnabled || process.platform !== 'win32') return;
  monitorInFlight = true;
  try {
    const matches = await getMeetingWindows();
    // Do not jump to another browser/meeting window merely because the current title
    // briefly changed. Wait for the active target to be absent for the grace period.
    if (currentCapture) {
      const now = Date.now();
      const transition = classifyWindowTransition(matches, currentCapture);

      if (transition.type === 'same-window') {
        currentCapture.lastMatchedAt = now;
      } else if (transition.type === 'same-meeting-identity-upgrade') {
        const previousKey = currentCapture.sessionKey;
        currentCapture.sessionKey = transition.sessionKey;
        currentCapture.title = transition.window.title || currentCapture.title;
        currentCapture.lastMatchedAt = now;
        console.info(`Google Meet exposed its call ID after capture began; continuing existing Contexa session ${currentCapture.meetingId} and upgrading identity ${previousKey} -> ${transition.sessionKey}.`);
      } else if (transition.type === 'different-meeting') {
        const differentIdentifiedMeeting = transition.window;
        // A different explicit call ID in the same long-lived browser process is a new meeting,
        // not a title flap. End the old session before starting the new one.
        await stopCapture(`A different meeting identity was detected (${currentCapture.sessionKey} → ${meetingKey(differentIdentifiedMeeting.processName, differentIdentifiedMeeting.title)})`, { endNow: true });
        restartBlock = null;
        await startCaptureForWindow(differentIdentifiedMeeting);
        return;
      } else if (transition.type === 'same-meeting-new-process') {
        // The same stable call moved to a replacement browser process/window. Defer the end and
        // let SessionContinuity reclaim the same Contexa session by exact meeting identity.
        await stopCapture('The same meeting moved to another application process');
        await startCaptureForWindow(transition.window);
        return;
      }

      const stop = captureStopReason({
        now,
        startedAt: currentCapture.startedAt,
        lastMatchedAt: currentCapture.lastMatchedAt,
        lastAudibleAt: currentCapture.audioStats?.lastAudibleAt || 0,
        policy: CAPTURE_POLICY,
      });
      if (stop?.reason === 'window-missing') {
        await stopCapture(`The meeting window was not present for ${Math.round(stop.missingForMs / 1000)} seconds and no one was audible for ${Math.round(stop.quietForMs / 1000)} seconds`);
      } else if (stop?.reason === 'idle') {
        // The meeting page can stay open after the call ends. Silence from everyone means it is over.
        restartBlock = { pid: currentCapture.processId, key: currentCapture.sessionKey, until: now + IDLE_RESTART_BLOCK_MS };
        await stopCapture(`No one was audible for ${Math.round(stop.quietForMs / 1000)} seconds; treating the meeting as ended`, { endNow: true });
      }
      return;
    }

    const selection = selectStartCandidate(matches, restartBlock, Date.now(), (windowInfo) => meetingKey(windowInfo.processName, windowInfo.title));
    restartBlock = selection.block;
    const match = selection.candidate;
    if (match) {
      const attemptKey = `${match.pid}:${meetingKey(match.processName, match.title)}`;
      const elapsedSinceAttempt = Date.now() - lastStartAttemptAt;
      if (attemptKey !== lastStartAttemptKey || elapsedSinceAttempt >= 30000) {
        lastStartAttemptKey = attemptKey;
        lastStartAttemptAt = Date.now();
        if (await ensureLocalServices()) await startCaptureForWindow(match);
        else console.warn('Automatic capture paused: local Contexa services are not available yet.');
      }
    }
  } finally {
    monitorInFlight = false;
    updateTrayMenu();
  }
}

function getDesktopStatus() {
  return {
    isDesktop: true,
    autoCaptureEnabled: Boolean(settings.autoCaptureEnabled),
    captureActive: Boolean(currentCapture),
    meetingTitle: currentCapture?.title ?? null,
    lastCaptureError: lastCaptureError || null,
  };
}

async function enableAutoCapture() {
  if (settings.autoCaptureEnabled) {
    const ready = await ensureLocalServices();
    if (ready) {
      await runSessionCleanup();
      startMonitoring();
    }
    updateTrayMenu();
    return {
      ok: ready,
      message: ready
        ? (currentCapture ? 'Auto Capture is enabled and a meeting is being captured.' : 'Auto Capture is enabled. Contexa is watching for supported meetings.')
        : 'Auto Capture is enabled, but Contexa services are not ready. Check Docker, the backend and database.',
      status: getDesktopStatus(),
    };
  }

  if (settings.consentVersion !== 1) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Enable Auto Capture', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Enable Contexa Auto Capture',
      message: 'Contexa will detect supported meeting windows and capture their application audio plus your microphone only while a meeting window is detected. The sources are sent on separate audio channels so your voice can be identified as microphone audio.',
      detail: 'Raw audio is streamed for transcription and is not stored by Contexa. Microphone audio may include nearby room sounds while a recognized meeting is open. Browser process capture may include other audible tabs in that browser. Please notify participants and obtain required permissions. You can pause or quit capture at any time.',
    });
    if (result.response !== 0) {
      return { ok: false, message: 'Auto Capture was not enabled.', status: getDesktopStatus() };
    }
    settings.consentVersion = 1;
  }

  const ready = await ensureLocalServices();
  if (!ready) {
    return { ok: false, message: 'Contexa services are not ready. Check Docker, the backend and database.', status: getDesktopStatus() };
  }

  await runSessionCleanup();
  settings.autoCaptureEnabled = true;
  settings.autoCapturePausedByUser = false;
  settings.firstRunPromptSeen = true;
  await saveSettings();
  setStartupEnabled(true);
  startMonitoring();
  updateTrayMenu();
  return { ok: true, message: 'Auto Capture is enabled. Contexa will start when a supported meeting is detected.', status: getDesktopStatus() };
}

async function pauseAutoCapture() {
  settings.autoCaptureEnabled = false;
  settings.autoCapturePausedByUser = true; // stays paused across restarts until the user turns it back on
  restartBlock = null;
  settings.firstRunPromptSeen = true;
  setStartupEnabled(false);
  stopMonitoring();
  await saveSettings();
  await stopCapture('Auto Capture was paused by the user', { endNow: true });
  await finalizePendingSession('Auto Capture was paused by the user');
  updateTrayMenu();
  return { ok: true, message: 'Auto Capture is paused. No new meeting audio will be captured.', status: getDesktopStatus() };
}

ipcMain.handle('contexa:get-status', () => getDesktopStatus());
ipcMain.handle('contexa:enable-auto-capture', () => enableAutoCapture());
ipcMain.handle('contexa:pause-auto-capture', () => pauseAutoCapture());

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(currentCapture
    ? `Contexa — Recording: ${currentCapture.title}`
    : settings.autoCaptureEnabled ? 'Contexa — Watching for meetings' : 'Contexa — Auto Capture paused');
  const menu = Menu.buildFromTemplate([
    { label: currentCapture ? `Capturing: ${currentCapture.title}` : settings.autoCaptureEnabled ? 'Auto Capture is enabled' : 'Auto Capture is paused', enabled: false },
    { label: 'Open Contexa', click: () => { void openMainWindow(); void ensureLocalServices(); } },
    { type: 'separator' },
    {
      label: settings.autoCaptureEnabled ? 'Pause Auto Capture' : 'Enable Auto Capture',
      click: async () => {
        if (settings.autoCaptureEnabled) await pauseAutoCapture();
        else await enableAutoCapture();
        updateTrayMenu();
      },
    },
    { label: 'Open Project README', click: () => shell.openPath(path.resolve(__dirname, '..', 'README.md')) },
    { type: 'separator' },
    { label: 'Quit Contexa', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isQuitting = true;
  stopMonitoring();
  clearTimeout(finalizeTimer);
  // Any previously deferred session has already been persisted as suspended. Do not
  // convert it to ended merely because the desktop process is closing.
  continuity.release();
  void (async () => {
    try {
      if (currentCapture) {
        await stopCapture('Contexa is closing; preserving the meeting for recovery', { suspendOnly: true });
      }
    } finally {
      try { uiServer?.close(); } catch { /* best effort */ }
      shutdownComplete = true;
      app.quit();
    }
  })();
});

// Ctrl+C / console termination should get the same best-effort transcript flush and
// persisted suspension as the tray Quit command. A hard kill cannot run this hook;
// active stable-key sessions remain recoverable through POST /api/meetings/auto.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shutdownInProgress || shutdownComplete) return;
    shutdownInProgress = true;
    isQuitting = true;
    stopMonitoring();
    clearTimeout(finalizeTimer);
    continuity.release();
    void (async () => {
      try {
        if (currentCapture) {
          await stopCapture(`Contexa received ${signal}; preserving the meeting for recovery`, { suspendOnly: true });
        }
      } finally {
        app.exit(signal === 'SIGINT' ? 130 : 0);
      }
    })();
  });
}

app.setName('Contexa');
app.setAppUserModelId('com.contexa.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    if (process.platform !== 'win32') {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Contexa Desktop',
        message: 'This first desktop app build supports Windows 10/11 only.',
        detail: 'This initial desktop capture build supports Windows 10/11 only.',
      });
      app.quit();
      return;
    }

    await loadSettings();
    if (!settings.firstRunPromptSeen && settings.consentVersion !== 1) {
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Enable Auto Capture', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Set up Contexa Desktop',
        message: 'Enable hands-free meeting capture?',
        detail: 'When enabled, Contexa watches window titles for supported meeting applications. It captures that application’s audio process plus the microphone only while a supported meeting window is detected, keeping meeting playback and your mic on separate channels. Raw audio is streamed for transcription and is not stored. Browser process capture can include other audible tabs in that browser. You remain responsible for participant notice and consent. You can enable or pause capture later from the main window or system tray.',
      });
      settings.firstRunPromptSeen = true;
      if (result.response === 0) {
        settings.consentVersion = 1;
        settings.autoCapturePausedByUser = false;
      } else {
        settings.autoCapturePausedByUser = true;
      }
    } else if (!settings.firstRunPromptSeen) {
      settings.firstRunPromptSeen = true;
    }

    // With recorded consent, Auto Capture is on at every launch unless the user paused it.
    settings.autoCaptureEnabled = resolveAutoCapture(settings);
    await saveSettings();
    setStartupEnabled(settings.autoCaptureEnabled);


    const iconPath = path.join(__dirname, 'assets', 'contexa-tray.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.on('click', () => { void openMainWindow(); });
    tray.on('double-click', () => { void openMainWindow(); });
    updateTrayMenu();

    // Always open the desktop window at startup. Local API/DB bootstrap runs separately,
    // so the UI can show useful setup/status messages instead of launching a browser.
    await openMainWindow();
    // Bring the API/database up and finish stale-session cleanup BEFORE detection starts.
    // Otherwise the first monitor tick can create/reuse a meeting while cleanup is still
    // closing stale rows from the previous Electron process.
    void ensureLocalServices().then(async (ready) => {
      if (!ready) {
        tray?.displayBalloon?.({ title: 'Contexa is waiting for local services', content: 'Open Contexa to see setup details. Docker, the backend and database may need attention.' });
        return;
      }
      await runSessionCleanup();
      if (settings.autoCaptureEnabled) startMonitoring();
    });
  });

  app.on('second-instance', () => { void openMainWindow(); });
}
