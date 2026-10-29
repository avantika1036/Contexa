import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./App.css";

type TabId = "transcript" | "catchup" | "topic" | "decisions";
type ConnectionStatus = "connecting" | "connected" | "disconnected";
type AudioSource = "tab" | "microphone";
type MeetingStatus = "active" | "ended";

type Meeting = {
  id: string;
  title: string;
  status: MeetingStatus;
  audio_source: AudioSource | null;
  created_at: string;
  ended_at: string | null;
};

type TranscriptWord = {
  word: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
};

type TranscriptSegment = {
  id: string;
  meeting_id: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: number | null;
  confidence: number | null;
  words: TranscriptWord[] | null;
  created_at?: string;
  is_final: boolean;
};

type ServerMessage = {
  type?: string;
  meeting_id?: string;
  title?: string;
  message?: string;
  message_type?: string;
  byte_length?: number;
  transcription_status?: string;
  code?: string;
  provider?: string;
  model?: string;
  segment?: TranscriptSegment;
  is_final?: boolean;
  speech_final?: boolean;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const WS_BASE = (import.meta.env.VITE_WS_BASE_URL || "").replace(/\/$/, "");

const tabs: { id: TabId; label: string }[] = [
  { id: "transcript", label: "Live transcript" },
  { id: "catchup", label: "Catch me up" },
  { id: "topic", label: "Current topic" },
  { id: "decisions", label: "Key decisions" },
];

const participants = [
  { name: "Sarah Chen", role: "Engineering", initials: "SC", style: "blue" },
  { name: "Rahul Mehta", role: "Engineering", initials: "RM", style: "purple" },
  { name: "Aman Verma", role: "Product", initials: "AV", style: "green" },
  { name: "Priya Sharma", role: "Product", initials: "PS", style: "orange" },
];

function formatTranscriptTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatMeetingDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    return body.detail || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("transcript");
  const [connection, setConnection] = useState<ConnectionStatus>("disconnected");
  const [connectionMessage, setConnectionMessage] = useState(
    "Create or select an active meeting to connect.",
  );
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [newMeetingTitle, setNewMeetingTitle] = useState("");
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
  const [question, setQuestion] = useState("");

  const [audioSource, setAudioSource] = useState<AudioSource>("tab");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [captureActive, setCaptureActive] = useState(false);
  const [captureStarting, setCaptureStarting] = useState(false);
  const [captureMessage, setCaptureMessage] = useState(
    "Audio capture has not started.",
  );
  const [audioChunksSent, setAudioChunksSent] = useState(0);
  const [audioChunksAcknowledged, setAudioChunksAcknowledged] = useState(0);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [interimTranscript, setInterimTranscript] = useState<TranscriptSegment | null>(null);
  const [transcriptionConfigured, setTranscriptionConfigured] = useState<boolean | null>(null);
  const [transcriptionProvider, setTranscriptionProvider] = useState("deepgram");

  const socketRef = useRef<WebSocket | null>(null);
  const meetingHistorySelectRef = useRef<HTMLSelectElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const firstChunkTimeoutRef = useRef<number | null>(null);
  const firstAudioChunkReceivedRef = useRef(false);
  const captureStreamsRef = useRef<MediaStream[]>([]);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const stopCapturePromiseRef = useRef<Promise<void> | null>(null);
  const stopCaptureResolverRef = useRef<(() => void) | null>(null);
  const captureFinalizingRef = useRef(false);
  const audioDeliveryFailedRef = useRef(false);
  const captureSourceAtStartRef = useRef<AudioSource>("tab");

  const selectedMeeting = meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null;
  const selectedMeetingStatus = selectedMeeting?.status ?? null;
  const effectiveConnection: ConnectionStatus =
    selectedMeetingStatus === "active" ? connection : "disconnected";
  const displayedConnectionMessage = !selectedMeetingId
    ? "Create or select a meeting session to connect."
    : selectedMeetingStatus === "ended"
      ? "This meeting has ended. Select or create an active session to connect."
      : connectionMessage;

  useEffect(() => {
    let cancelled = false;

    async function loadMeetings() {
      setMeetingsLoading(true);
      try {
        const response = await fetch(`${API_BASE}/api/meetings`);
        if (!response.ok) throw new Error(await responseError(response));
        const result = (await response.json()) as Meeting[];
        if (cancelled) return;

        setMeetings(result);
        const preferred = result.find((meeting) => meeting.status === "active") ?? result[0];
        setSelectedMeetingId((current) => {
          if (current && result.some((meeting) => meeting.id === current)) {
            return current;
          }
          return preferred?.id ?? null;
        });
        setConnection(preferred?.status === "active" ? "connecting" : "disconnected");
        setConnectionMessage(preferred?.status === "active"
          ? "Connecting to the selected meeting..."
          : "Create or select an active meeting to connect.");
        setSessionMessage(result.length ? "Meeting sessions loaded." : "Create a meeting session to begin.");
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not load meeting sessions.";
          setSessionMessage(`${message} Check that the API and database are running.`);
        }
      } finally {
        if (!cancelled) setMeetingsLoading(false);
      }
    }

    void loadMeetings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadTranscriptionStatus() {
      try {
        const response = await fetch(`${API_BASE}/api/transcription/status`);
        if (!response.ok) throw new Error(await responseError(response));
        const result = (await response.json()) as { configured: boolean; provider?: string };
        if (cancelled) return;
        setTranscriptionConfigured(result.configured);
        setTranscriptionProvider(result.provider || "speech-to-text provider");
      } catch {
        if (!cancelled) setTranscriptionConfigured(false);
      }
    }

    void loadTranscriptionStatus();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!selectedMeetingId) return () => { cancelled = true; };

    async function loadTranscript() {
      try {
        const response = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId!)}/transcript`);
        if (!response.ok) throw new Error(await responseError(response));
        const segments = (await response.json()) as TranscriptSegment[];
        if (!cancelled) setTranscriptSegments(segments);
      } catch (error) {
        if (!cancelled) {
          const detail = error instanceof Error ? error.message : "Unknown error";
          setCaptureMessage(`Could not load this meeting's saved transcript: ${detail}`);
        }
      }
    }

    void loadTranscript();
    return () => { cancelled = true; };
  }, [selectedMeetingId]);

  useEffect(() => {
    if (!selectedMeetingId || selectedMeetingStatus !== "active") {
      socketRef.current = null;
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname || "127.0.0.1";
    const base = WS_BASE || `${protocol}://${host}:8000`;
    const socket = new WebSocket(
      `${base}/ws/meeting/${encodeURIComponent(selectedMeetingId)}`,
    );
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      setConnection("connected");
      setConnectionMessage("Connected to the selected meeting session.");
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (socketRef.current !== socket) return;

      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        setConnectionMessage("Received an unrecognized server message.");
        return;
      }

      switch (message.type) {
        case "connection.established":
          setConnectionMessage(`Connected to ${message.title ?? "the selected meeting"}.`);
          break;
        case "pong":
          setConnectionMessage("WebSocket connection test successful.");
          break;
        case "message.received":
          if (message.message_type === "audio.start") {
            setCaptureMessage("Backend acknowledged the start of audio capture.");
          } else if (message.message_type === "audio.stop") {
            setInterimTranscript(null);
            setCaptureMessage("Audio stream finalized; pending transcript results are being saved.");
          } else if (message.message_type === "question") {
            setConnectionMessage("Question delivered. AI answering is not implemented yet.");
          } else {
            setConnectionMessage(`Backend acknowledged: ${message.message_type ?? "message"}.`);
          }
          break;
        case "transcription.ready":
          setCaptureMessage(`Connected to ${message.provider ?? transcriptionProvider} streaming transcription (${message.model ?? "configured model"}).`);
          break;
        case "transcript.segment": {
          const segment = message.segment;
          if (!segment) break;
          if (message.is_final || segment.is_final) {
            setTranscriptSegments((current) => {
              const withoutDuplicate = current.filter((item) => item.id !== segment.id);
              return [...withoutDuplicate, { ...segment, is_final: true }].sort(
                (a, b) => a.start_seconds - b.start_seconds,
              );
            });
            setInterimTranscript((current) =>
              current && Math.abs(current.start_seconds - segment.start_seconds) < 0.75
                ? null
                : current,
            );
            setCaptureMessage(message.speech_final
              ? "Final transcript segment saved."
              : "Transcript segment finalized and saved.");
          } else {
            setInterimTranscript(segment);
          }
          break;
        }
        case "audio.chunk.received":
          setAudioChunksAcknowledged((count) => count + 1);
          setCaptureMessage(
            `Audio forwarded to ${transcriptionProvider} (${message.byte_length ?? 0} bytes). Waiting for transcript…`,
          );
          break;
        case "transcription.error": {
          const detail = message.message ?? "The transcription provider returned an error.";
          setCaptureMessage(detail);
          const recorder = mediaRecorderRef.current;
          if (recorder && recorder.state !== "inactive") {
            void stopCapture().then(() => setCaptureMessage(detail));
          }
          break;
        }
        case "error":
          setConnectionMessage(message.message ?? "The server returned an error.");
          break;
        default:
          setConnectionMessage("Received a response from the meeting service.");
      }
    };

    socket.onerror = () => {
      if (socketRef.current !== socket) return;
      setConnectionMessage("Could not connect. Check that FastAPI is running.");
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnection("disconnected");
      setConnectionMessage("Disconnected from the meeting service.");
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        void stopCapture();
      }
    };

    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
    // This WebSocket belongs to exactly one selected active meeting session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMeetingId, selectedMeetingStatus]);

  function sendMessage(payload: Record<string, unknown>): boolean {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnectionMessage("Not connected. Select an active meeting and start the API.");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  function testConnection() {
    sendMessage({ type: "ping" });
  }

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newMeetingTitle.trim();
    if (!title || creatingMeeting || captureActive) return;

    setCreatingMeeting(true);
    setSessionMessage("");
    try {
      const response = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(await responseError(response));

      const created = (await response.json()) as Meeting;
      setMeetings((current) => [created, ...current]);
      setSelectedMeetingId(created.id);
      setConnection("connecting");
      setConnectionMessage("Connecting to the new meeting session...");
      setNewMeetingTitle("");
      setSessionMessage(`Created session “${created.title}”.`);
      setActiveTab("transcript");
      setConsentConfirmed(false);
      setAudioChunksSent(0);
      setAudioChunksAcknowledged(0);
      setTranscriptSegments([]);
      setInterimTranscript(null);
      setCaptureMessage("Audio capture has not started.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the meeting.";
      setSessionMessage(`${message} Ensure the database migration has been applied.`);
    } finally {
      setCreatingMeeting(false);
    }
  }

  async function endMeeting() {
    if (!selectedMeeting || selectedMeeting.status !== "active") return;
    setSessionMessage("");

    try {
      if (mediaRecorderRef.current) await stopCapture();
      const response = await fetch(`${API_BASE}/api/meetings/${selectedMeeting.id}/end`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const ended = (await response.json()) as Meeting;
      setMeetings((current) => current.map((meeting) => meeting.id === ended.id ? ended : meeting));
      setConnection("disconnected");
      setSessionMessage(`Meeting “${ended.title}” has ended. Its session record is preserved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not end the meeting.";
      setSessionMessage(message);
    }
  }

  function releaseCaptureStreams() {
    captureStreamsRef.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    captureStreamsRef.current = [];
  }

  async function finalizeCapture() {
    if (captureFinalizingRef.current) return;
    captureFinalizingRef.current = true;

    try {
      await sendQueueRef.current;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "audio.stop", source: captureSourceAtStartRef.current }));
      }
      setCaptureMessage(
        audioDeliveryFailedRef.current
          ? "Capture stopped, but one or more audio chunks may not have been delivered."
          : "Capture stopped. Audio chunks were streamed, but this milestone does not transcribe or store audio.",
      );
    } catch {
      setCaptureMessage("Capture stopped, but some queued audio could not be delivered.");
    } finally {
      if (firstChunkTimeoutRef.current !== null) {
        window.clearTimeout(firstChunkTimeoutRef.current);
        firstChunkTimeoutRef.current = null;
      }
      releaseCaptureStreams();
      mediaRecorderRef.current = null;
      setCaptureActive(false);
      const resolve = stopCaptureResolverRef.current;
      stopCaptureResolverRef.current = null;
      stopCapturePromiseRef.current = null;
      captureFinalizingRef.current = false;
      resolve?.();
    }
  }

  function stopCapture(): Promise<void> {
    if (stopCapturePromiseRef.current) return stopCapturePromiseRef.current;

    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      releaseCaptureStreams();
      setCaptureActive(false);
      return Promise.resolve();
    }

    const pending = new Promise<void>((resolve) => {
      stopCaptureResolverRef.current = resolve;
      if (recorder.state !== "inactive") recorder.stop();
      // If state is already inactive, the browser may have fired stop due to
      // the shared tab ending; its onstop handler will resolve this promise.
    });
    stopCapturePromiseRef.current = pending;
    return pending;
  }

  async function startCapture() {
    if (captureStarting) return;
    if (!selectedMeeting || selectedMeeting.status !== "active") {
      setCaptureMessage("Create or select an active meeting before capturing audio.");
      return;
    }
    if (!consentConfirmed) {
      setCaptureMessage("Confirm that you have permission to capture this meeting first.");
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setCaptureMessage("The meeting connection is not ready. Wait for Connected and try again.");
      return;
    }
    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
      setCaptureMessage("This browser does not expose microphone recording APIs. Try the latest Chrome or Edge on localhost.");
      return;
    }
    if (mediaRecorderRef.current) {
      setCaptureMessage("An audio capture session is already active. Use Stop capture first.");
      return;
    }

    setCaptureStarting(true);
    setCaptureMessage(
      audioSource === "tab"
        ? "Waiting for the browser sharing picker. Choose a browser tab and enable Share tab audio."
        : "Requesting microphone permission. If no prompt appears, check this site's microphone permission in the browser address bar.",
    );

    let sourceStream: MediaStream | null = null;
    try {
      const statusResponse = await fetch(`${API_BASE}/api/transcription/status`);
      if (!statusResponse.ok) throw new Error(await responseError(statusResponse));
      const status = (await statusResponse.json()) as { configured: boolean; provider?: string };
      setTranscriptionConfigured(status.configured);
      setTranscriptionProvider(status.provider || "deepgram");
      if (!status.configured) {
        setCaptureMessage("Streaming transcription is not configured. Add DEEPGRAM_API_KEY to the repository-root .env file, then restart FastAPI.");
        return;
      }

      if (audioSource === "tab") {
        if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
          throw new Error("This browser does not support tab/screen capture. Try current Chrome or Edge.");
        }
        sourceStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } else {
        if (typeof navigator.mediaDevices.getUserMedia !== "function") {
          throw new Error("This browser does not expose microphone access. Use a current browser on http://127.0.0.1:5173.");
        }
        sourceStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      const audioTracks = sourceStream.getAudioTracks();
      if (audioTracks.length === 0) {
        sourceStream.getTracks().forEach((track) => track.stop());
        sourceStream = null;
        setCaptureMessage(
          audioSource === "tab"
            ? 'The browser picker returned no audio track. Choose a Chrome Tab, select the meeting tab, and enable "Share tab audio"; or choose Microphone only.'
            : "The browser returned no microphone audio track. Check site permissions and that an input device is connected.",
        );
        return;
      }

      const selectedTrack = audioTracks[0];
      if (selectedTrack.readyState !== "live" || !selectedTrack.enabled) {
        sourceStream.getTracks().forEach((track) => track.stop());
        sourceStream = null;
        setCaptureMessage("The selected audio track is not live or is disabled. Check your audio device and retry.");
        return;
      }

      captureStreamsRef.current = [sourceStream];
      captureSourceAtStartRef.current = audioSource;
      setAudioChunksSent(0);
      setAudioChunksAcknowledged(0);
      sendQueueRef.current = Promise.resolve();
      audioDeliveryFailedRef.current = false;
      captureFinalizingRef.current = false;
      firstAudioChunkReceivedRef.current = false;

      setCaptureMessage(
        `Audio device ready (${selectedTrack.label || "audio track"}). Initializing recorder…`,
      );

      // getDisplayMedia needs a video track, but only its audio tracks are recorded/sent.
      const audioOnlyStream = new MediaStream(audioTracks);
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType
        ? new MediaRecorder(audioOnlyStream, { mimeType })
        : new MediaRecorder(audioOnlyStream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size === 0) {
          setCaptureMessage("Recorder is running but emitted an empty chunk. Check that the microphone is not muted and the input meter is moving.");
          return;
        }

        firstAudioChunkReceivedRef.current = true;
        if (firstChunkTimeoutRef.current !== null) {
          window.clearTimeout(firstChunkTimeoutRef.current);
          firstChunkTimeoutRef.current = null;
        }

        const chunk = event.data;
        setCaptureMessage(`Captured ${chunk.size} bytes of audio; sending to the selected meeting…`);
        sendQueueRef.current = sendQueueRef.current
          .then(async () => {
            const activeSocket = socketRef.current;
            if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
              throw new Error("WebSocket is no longer connected. Create/select an active session and reconnect.");
            }
            if (activeSocket.bufferedAmount > 4_000_000) {
              throw new Error("Audio send queue is congested. Stop capture and reconnect.");
            }
            const bytes = await chunk.arrayBuffer();
            activeSocket.send(bytes);
            setAudioChunksSent((count) => count + 1);
            setCaptureMessage(`Sent an audio chunk (${bytes.byteLength} bytes). Waiting for backend acknowledgement…`);
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : "Unknown delivery error.";
            audioDeliveryFailedRef.current = true;
            setCaptureMessage(`Audio delivery failed: ${detail}`);
          });
      };

      recorder.onerror = () => {
        setCaptureMessage("The browser's MediaRecorder reported an error. Stop capture and check microphone permissions.");
        if (recorder.state !== "inactive") void stopCapture();
      };
      recorder.onstop = () => {
        void finalizeCapture();
      };

      // Ended audio/video tracks should release capture cleanly.
      sourceStream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            void stopCapture();
          }
        }, { once: true });
      });

      if (!sendMessage({
        type: "audio.start",
        source: audioSource,
        mime_type: recorder.mimeType,
        chunk_interval_ms: 1000,
      })) {
        recorder.ondataavailable = null;
        mediaRecorderRef.current = null;
        releaseCaptureStreams();
        setCaptureMessage("Could not start capture because the backend WebSocket disconnected.");
        return;
      }

      recorder.start(1000);
      setCaptureActive(true);
      setCaptureMessage(
        `Recorder started (${recorder.mimeType || "browser-selected audio format"}). Waiting for the first audio chunk…`,
      );
      firstChunkTimeoutRef.current = window.setTimeout(() => {
        const activeRecorder = mediaRecorderRef.current;
        if (
          activeRecorder === recorder &&
          activeRecorder.state === "recording" &&
          !firstAudioChunkReceivedRef.current
        ) {
          const trackInfo = sourceStream?.getAudioTracks()
            .map((track) => `${track.readyState}${track.enabled ? "/enabled" : "/disabled"}${track.muted ? "/muted" : "/unmuted"}`)
            .join(", ") || "no audio tracks";
          setCaptureMessage(
            `Recorder is active but no audio chunk has arrived after 5 seconds (${trackInfo}). Check OS microphone input, browser site permission, and whether another app is using the microphone.`,
          );
        }
      }, 5000);
    } catch (error: unknown) {
      if (firstChunkTimeoutRef.current !== null) {
        window.clearTimeout(firstChunkTimeoutRef.current);
        firstChunkTimeoutRef.current = null;
      }
      sourceStream?.getTracks().forEach((track) => track.stop());
      captureStreamsRef.current = [];
      mediaRecorderRef.current = null;
      setCaptureActive(false);

      const name = error instanceof DOMException ? error.name : "";
      const detail = error instanceof Error ? error.message : "Unknown capture error.";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCaptureMessage("Permission was denied or blocked. Allow microphone/screen capture for this local site in browser permissions, then retry.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCaptureMessage("No microphone/input device was found. Connect or enable a microphone and retry.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setCaptureMessage("The microphone exists but cannot be read. Check Windows microphone privacy settings and close other apps using it.");
      } else if (name === "AbortError") {
        setCaptureMessage("Audio capture was interrupted by the browser. Retry and keep the capture picker open until selection completes.");
      } else {
        setCaptureMessage(`Could not start audio capture (${name || "error"}): ${detail}`);
      }
    } finally {
      setCaptureStarting(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    if (sendMessage({ type: "question", text })) {
      setQuestion("");
      setConnectionMessage("Question delivered. Grounded AI answers are not implemented yet.");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Contexa home">
          <span className="brand-mark">C</span><span>contexa</span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <button className="nav-item active" type="button">
          <span className="nav-icon">▦</span>Meetings
        </button>
        <button
          className="nav-item history-nav-item"
          type="button"
          title="Jump to meeting history"
          onClick={() => {
            const selector = meetingHistorySelectRef.current;
            selector?.scrollIntoView({ behavior: "smooth", block: "center" });
            selector?.focus({ preventScroll: true });
            setSessionMessage("Choose a saved session from the Meeting history dropdown.");
          }}
        >
          <span className="nav-icon">◷</span>Meeting history
        </button>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <span className="privacy-icon">◇</span>
            <div><strong>Privacy matters</strong><p>Capture starts only after your confirmation and browser permission.</p></div>
          </div>
          <div className="profile">
            <div className="profile-avatar">A</div>
            <div><strong>Local workspace</strong><p>Development environment</p></div>
          </div>
        </div>
      </aside>

      <main className="main-area" id="home">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Meetings <span>/</span><strong>{selectedMeeting ? selectedMeeting.title : "No session selected"}</strong></div>
          <div className="topbar-right">
            <span className={`connection-pill ${effectiveConnection}`}><span className="status-dot" />{effectiveConnection === "connected" ? "Session connected" : effectiveConnection === "connecting" ? "Connecting" : "Offline"}</span>
            <span className="environment-tag">LOCAL DEV</span>
          </div>
        </header>

        <div className="workspace">
          <section className="meeting-column">
            <div className="meeting-heading">
              <div>
                <div className="eyebrow">MEETING WORKSPACE</div>
                <h1>{selectedMeeting?.title ?? "Start with a meeting"}</h1>
                <p className="meeting-subtitle">
                  {selectedMeeting
                    ? `${selectedMeeting.status === "active" ? "Active session" : "Ended session"} · Created ${formatMeetingDate(selectedMeeting.created_at)}`
                    : "Create a session to keep each meeting's context separate."}
                </p>
              </div>
              <button className="outline-button" type="button" onClick={testConnection} disabled={effectiveConnection !== "connected"}>
                ↗ Test connection
              </button>
            </div>

            <section className="session-manager" aria-label="Meeting session management">
              <form className="session-create-form" onSubmit={createMeeting}>
                <label htmlFor="new-meeting-title">New meeting session</label>
                <div className="session-create-row">
                  <input
                    id="new-meeting-title"
                    value={newMeetingTitle}
                    onChange={(event) => setNewMeetingTitle(event.target.value)}
                    placeholder="e.g. Product sync — 29 Oct"
                    maxLength={200}
                    required
                    disabled={creatingMeeting || captureActive || captureStarting}
                  />
                  <button type="submit" disabled={creatingMeeting || captureActive || captureStarting || !newMeetingTitle.trim()}>
                    {creatingMeeting ? "Creating…" : "+ Create session"}
                  </button>
                </div>
              </form>

              <div className="session-select-row">
                <label htmlFor="meeting-session-select">Meeting history</label>
                <select
                  ref={meetingHistorySelectRef}
                  id="meeting-session-select"
                  value={selectedMeetingId ?? ""}
                  onChange={(event) => {
                    const nextId = event.target.value || null;
                    const nextMeeting = meetings.find((meeting) => meeting.id === nextId) ?? null;
                    setTranscriptSegments([]);
                    setInterimTranscript(null);
                    setSelectedMeetingId(nextId);
                    setConsentConfirmed(false);
                    setConnection(nextMeeting?.status === "active" ? "connecting" : "disconnected");
                    setConnectionMessage(nextMeeting?.status === "active"
                      ? "Connecting to the selected meeting..."
                      : "Select an active meeting to connect.");
                  }}
                  disabled={captureActive || captureStarting || meetingsLoading || meetings.length === 0}
                >
                  <option value="">Select a meeting session</option>
                  {meetings.map((meeting) => (
                    <option key={meeting.id} value={meeting.id}>
                      {meeting.title} — {meeting.status === "active" ? "Active" : "Ended"}
                    </option>
                  ))}
                </select>
                {selectedMeeting?.status === "active" && (
                  <button className="end-session-button" type="button" onClick={() => void endMeeting()} disabled={captureStarting || (captureActive && !mediaRecorderRef.current)}>
                    End meeting
                  </button>
                )}
              </div>
              {sessionMessage && <p className="session-message" role="status">{sessionMessage}</p>}
              {meetingsLoading && <p className="session-message">Loading meeting history…</p>}
            </section>

            <div className="meeting-stage">
              <div className="stage-top">
                <span className="stage-live"><span className="status-dot" />{captureActive ? "Audio capture active" : selectedMeeting?.status === "active" ? "Meeting session ready" : "Session preview"}</span>
                <span className="participant-count">Illustrative participant layout</span>
              </div>
              <div className="participant-grid">
                {participants.map((participant, index) => (
                  <div className={`participant-card ${participant.style}`} key={participant.initials}>
                    <div className={`participant-avatar ${participant.style}`}>{participant.initials}</div>
                    <div className="participant-info"><strong>{participant.name}</strong><span>{participant.role}</span></div>
                    <span className="participant-number">0{index + 1}</span>
                  </div>
                ))}
              </div>
              <div className="stage-footer"><span>Participant tiles are illustrative, not a live video feed.</span><span>{selectedMeeting ? `Session ID: ${selectedMeeting.id}` : "No meeting session created yet."}</span></div>
            </div>

            <div className="meeting-note">
              <div className="note-icon">i</div>
              <div><strong>Context stays with the discussion</strong><p>Each session has its own ID. Transcript, decisions, and meeting memory will be attached to that session as those features are implemented.</p></div>
            </div>

            <div className="meeting-actions">
              <span className="action-label">AUDIO CAPTURE</span>
              <div className="capture-source-row">
                <label htmlFor="audio-source">Audio source</label>
                <select id="audio-source" value={audioSource} onChange={(event) => setAudioSource(event.target.value as AudioSource)} disabled={captureActive}>
                  <option value="tab">Browser tab audio</option>
                  <option value="microphone">Microphone only</option>
                </select>
              </div>
              <label className="consent-checkbox">
                <input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} disabled={captureActive} />
                <span>I have informed the participants and have permission to capture this meeting. Audio will be streamed to my local Contexa backend.</span>
              </label>
              <div className="action-buttons">
                <button
                  type="button"
                  className={captureActive ? "stop-capture-button" : "start-capture-button"}
                  onClick={() => captureActive ? void stopCapture() : void startCapture()}
                  disabled={captureStarting || (captureActive ? false : (effectiveConnection !== "connected" || !selectedMeeting || selectedMeeting.status !== "active" || !consentConfirmed))}
                >
                  {captureStarting ? "Requesting permission…" : captureActive ? "■ Stop capture" : "● Start audio capture"}
                </button>
                <span className="controls-note">{captureActive ? `${audioChunksSent} sent · ${audioChunksAcknowledged} acknowledged` : "Requires an active session and browser permission."}</span>
              </div>
              <div className={`capture-status ${captureActive ? "is-active" : captureStarting ? "is-pending" : ""}`} role="status" aria-live="polite">
                <span className="capture-status-dot" aria-hidden="true" />
                <span>{captureMessage}</span>
              </div>
              <p className="capture-hint">For tab audio, choose a Chrome Tab in the browser picker and enable tab audio sharing. Microphone-only capture should request mic permission directly. Audio is streamed to the configured transcription provider; finalized transcript segments are saved with timestamps. Raw audio is not stored by Contexa.</p>
            </div>
          </section>

          <aside className="copilot-panel">
            <div className="copilot-heading">
              <div className="copilot-avatar">C</div>
              <div className="copilot-title"><h2>Meeting Copilot</h2><p>Live meeting context</p></div>
              <span className={`mini-status ${effectiveConnection}`}>{effectiveConnection === "connected" ? "Connected" : effectiveConnection === "connecting" ? "Connecting" : "Offline"}</span>
            </div>
            <div className="copilot-intro"><div className="intro-sparkle">✳</div><div><strong>Stay in context.</strong><p>Explore discussion context, recover missed information, and follow decisions.</p></div></div>
            <div className="copilot-tabs" role="tablist">
              {tabs.map((tab) => <button key={tab.id} id={`tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="copilot-content" className={activeTab === tab.id ? "selected" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
            </div>
            <section className="copilot-content" id="copilot-content" role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
              {activeTab === "transcript" && <div className="tab-content">
                <div className="content-heading"><div><h3>Live transcript</h3><p>Streaming speech-to-text · finalized segments saved to this meeting</p></div><span className={`preview-tag ${transcriptionConfigured ? "ready-tag" : ""}`}>{transcriptionConfigured === true ? "READY" : transcriptionConfigured === false ? "SETUP REQUIRED" : "CHECKING"}</span></div>
                {transcriptionConfigured === false && <div className="transcription-setup-notice"><strong>Configure streaming transcription</strong><p>Add your Deepgram API key as <code>DEEPGRAM_API_KEY</code> in the repository-root <code>.env</code> file, then restart FastAPI. The key must remain on the backend.</p></div>}
                {transcriptSegments.length === 0 && !interimTranscript && <div className="transcript-empty"><span className="empty-symbol">≋</span><strong>Your transcript will appear here</strong><p>Start audio capture and speak. Interim text will appear while you talk; finalized segments will be saved with timestamps.</p></div>}
                {interimTranscript && <div className="interim-transcript"><span className="transcript-live-dot" /><div><div className="transcript-speaker">{interimTranscript.speaker_id === null ? "Transcribing…" : `Speaker ${interimTranscript.speaker_id + 1} · live`}</div><p>{interimTranscript.text}</p></div></div>}
                {transcriptSegments.map((segment) => <article className="transcript-segment" key={segment.id}><time>{formatTranscriptTime(segment.start_seconds)}</time><div className="transcript-segment-body"><div className="transcript-speaker">{segment.speaker_id === null ? "Speaker not identified" : `Speaker ${segment.speaker_id + 1}`}</div><p>{segment.text}</p>{segment.words?.length ? <details><summary>Word timing</summary><div className="word-timing-list">{segment.words.map((word, index) => <span key={`${segment.id}-${index}`}>{word.word} <small>{typeof word.start === "number" ? formatTranscriptTime(word.start) : ""}</small></span>)}</div></details> : null}</div></article>)}
                {transcriptSegments.length > 0 && <p className="transcript-persistence-note">{transcriptSegments.length} finalized segment{transcriptSegments.length === 1 ? "" : "s"} saved for this meeting.</p>}
                <p className="sample-disclaimer">Transcription is streamed to Deepgram. Final transcript text, timestamps, confidence and available speaker IDs are stored in this meeting's database record; raw audio is not stored.</p>
              </div>}
              {activeTab === "catchup" && <div className="tab-content"><div className="content-heading"><div><h3>Catch me up</h3><p>Recover a missed part of the discussion</p></div><span className="preview-tag">NEXT PHASE</span></div><div className="transcript-empty"><span className="empty-symbol">↺</span><strong>Structured meeting memory is not available yet</strong><p>Live transcripts are now captured and saved. The next phase will extract proposals, arguments, decisions, open questions, and action items so this panel can summarise a missed discussion using evidence from this meeting.</p></div></div>}
              {activeTab === "topic" && <div className="tab-content"><div className="content-heading"><div><h3>Current topic</h3><p>What the conversation is about</p></div><span className="preview-tag">NEXT PHASE</span></div><div className="transcript-empty"><span className="empty-symbol">⌖</span><strong>Topic detection is not implemented yet</strong><p>Contexa will infer the current topic from saved transcript segments in the structured-memory phase.</p></div></div>}
              {activeTab === "decisions" && <div className="tab-content"><div className="content-heading"><div><h3>Key decisions</h3><p>Agreements and open questions</p></div><span className="preview-tag">NEXT PHASE</span></div><div className="transcript-empty"><span className="empty-symbol">✓</span><strong>No decisions recorded yet</strong><p>Transcript segments are stored with timestamps. The structured-memory phase will identify decisions, supporting and opposing arguments, open questions, and action items.</p></div></div>}
            </section>
            <div className="connection-feedback" role="status"><span className="feedback-dot" />{displayedConnectionMessage}</div>
            <form className="question-form" onSubmit={submitQuestion}>
              <label htmlFor="question-input">Ask about the meeting</label>
              <div className="question-input-row"><input id="question-input" type="text" placeholder="e.g. What options were discussed?" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} /><button type="submit" disabled={effectiveConnection !== "connected" || question.trim().length === 0} aria-label="Send question" title="Send question to backend">→</button></div>
              <p className="question-disclaimer">Currently tests message delivery only; grounded AI answers are not available yet.</p>
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;
