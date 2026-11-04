import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./App.css";

type TabId = "ask" | "transcript" | "catchup" | "topic" | "decisions" | "memory";
type ConnectionStatus = "connecting" | "connected" | "disconnected";
type AudioSource = "tab" | "desktop" | "microphone" | "desktop_auto" | "web_auto";
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
  language?: string;
};

type TranscriptSegment = {
  id: string;
  meeting_id: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: number | null;
  audio_channel?: number | null;
  confidence: number | null;
  words: TranscriptWord[] | null;
  created_at?: string;
  is_final: boolean;
};

type MemoryItemType =
  | "topic"
  | "fact"
  | "proposal"
  | "argument"
  | "question"
  | "open_question"
  | "decision"
  | "action_item"
  | "event"
  | "person"
  | "entity";

type MemoryItem = {
  id: string;
  meeting_id: string;
  item_type: MemoryItemType;
  title: string;
  content: string;
  status: string;
  decision_state: "proposed" | "discussing" | "tentative" | "decided" | null;
  owner: string | null;
  speaker_id: number | null;
  evidence_quote: string;
  source_segment_ids: string[];
  related_entities: string[];
  start_seconds: number;
  end_seconds: number;
  confidence: number;
  source: string;
  model_name: string | null;
  created_at: string;
  updated_at: string;
};

type DesktopStatus = {
  isDesktop: boolean;
  autoCaptureEnabled: boolean;
  captureActive: boolean;
  meetingTitle: string | null;
  lastCaptureError: string | null;
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
  items?: MemoryItem[];
  item_count?: number;
  processed_segments?: number;
  configured?: boolean;
  schema_ready?: boolean;
  provider_configured?: boolean;
  automatic_extraction?: boolean;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const WS_BASE = (import.meta.env.VITE_WS_BASE_URL || "").replace(/\/$/, "");
const isDesktopApp = new URLSearchParams(window.location.search).get("desktop") === "1";

const tabs: { id: TabId; label: string }[] = [
  { id: "ask", label: "Ask Contexa" },
  { id: "transcript", label: "Transcript" },
  { id: "catchup", label: "Catch me up" },
  { id: "topic", label: "Current topic" },
  { id: "decisions", label: "Key decisions" },
  { id: "memory", label: "Memory" },
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

type ChatEvidence = { segment_id: string; start_seconds: number; quote: string };
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  broaderContext?: string | null;
  evidence?: ChatEvidence[];
  scope?: "meeting" | "broader";
  error?: boolean;
};

type OverviewListCardProps = {
  title: string;
  count: number;
  items: MemoryItem[];
  emptyText: string;
  onViewAll: () => void;
  onOpenEvidence: (item: MemoryItem) => void;
  wide?: boolean;
};

function OverviewListCard({ title, count, items, emptyText, onViewAll, onOpenEvidence, wide = false }: OverviewListCardProps) {
  return (
    <section className={`overview-card overview-list-card ${wide ? "overview-card-wide" : ""}`}>
      <div className="overview-card-heading">
        <div><h3>{title}</h3><span className="overview-count">{count}</span></div>
        <button type="button" className="text-action" onClick={onViewAll}>View all <span>→</span></button>
      </div>
      {items.length > 0 ? (
        <div className="overview-mini-list">
          {items.slice(0, 2).map((item) => (
            <button type="button" className="overview-mini-item" key={item.id} onClick={() => onOpenEvidence(item)} title="Open supporting transcript">
              <span className="overview-mini-title">{item.title}</span>
              <span className="overview-mini-meta">{formatTranscriptTime(item.start_seconds)} <span aria-hidden="true">↗</span></span>
            </button>
          ))}
        </div>
      ) : <p className="overview-no-data">{emptyText}</p>}
    </section>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("ask");
  const [connection, setConnection] = useState<ConnectionStatus>("disconnected");
  const [backendHealth, setBackendHealth] = useState<"checking" | "online" | "offline">("checking");
  const [connectionMessage, setConnectionMessage] = useState(
    "Create or select an active meeting to connect.",
  );
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  // Automatic capture may follow a newly detected meeting until the user explicitly
  // chooses a history item. After that, background polling must not steal selection.
  const userPinnedMeetingSelectionRef = useRef(false);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [newMeetingTitle, setNewMeetingTitle] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [focusTranscriptSegmentId, setFocusTranscriptSegmentId] = useState<string | null>(null);
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");

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
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [memoryConfigured, setMemoryConfigured] = useState<boolean | null>(null);
  const [extractingMemory, setExtractingMemory] = useState(false);
  const [memoryMessage, setMemoryMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatMeetingId, setChatMeetingId] = useState<string | null>(null);
  const [chatQuestion, setChatQuestion] = useState("");
  const [chatScope, setChatScope] = useState<"meeting" | "broader">("meeting");
  const [chatSending, setChatSending] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopActionMessage, setDesktopActionMessage] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const newMeetingInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const firstChunkTimeoutRef = useRef<number | null>(null);
  const firstAudioChunkReceivedRef = useRef(false);
  const firstTranscriptReceivedRef = useRef(false);
  const firstTranscriptTimeoutRef = useRef<number | null>(null);
  const smallAudioAckCountRef = useRef(0);
  const captureStreamsRef = useRef<MediaStream[]>([]);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const stopCapturePromiseRef = useRef<Promise<void> | null>(null);
  const stopCaptureResolverRef = useRef<(() => void) | null>(null);
  const captureFinalizingRef = useRef(false);
  const audioDeliveryFailedRef = useRef(false);
  const captureSourceAtStartRef = useRef<AudioSource>("tab");
  const audioContextRef = useRef<AudioContext | null>(null);

  const selectedMeeting = meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null;
  const selectedMemoryItems = memoryItems.filter((item) => item.meeting_id === selectedMeetingId);
  const selectedMeetingStatus = selectedMeeting?.status ?? null;
  const effectiveConnection: ConnectionStatus =
    selectedMeetingStatus === "active" ? connection : "disconnected";

  const visibleChatMessages = chatMeetingId === selectedMeetingId ? chatMessages : [];

  useEffect(() => {
    if (activeTab === "ask" && chatMeetingId === selectedMeetingId) {
      chatBottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [activeTab, chatMessages, chatMeetingId, selectedMeetingId, chatSending]);
  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;

    async function loadMeetings() {
      const isFirstLoad = firstLoad;
      try {
        const response = await fetch(`${API_BASE}/api/meetings`);
        if (!response.ok) throw new Error(await responseError(response));
        const result = (await response.json()) as Meeting[];
        if (cancelled) return;

        setMeetings(result);
        // The Windows desktop app creates sessions automatically when a supported
        // meeting window appears. Prefer its active session so the workspace follows
        // the user's meeting without requiring a manual meeting-selection click.
        const autoMeeting = result.find(
          (meeting) => meeting.status === "active" && meeting.audio_source === "desktop_auto",
        );
        const preferred = autoMeeting ?? result.find((meeting) => meeting.status === "active") ?? result[0];
        setSelectedMeetingId((current) => {
          const currentStillExists = Boolean(current && result.some((meeting) => meeting.id === current));
          if (userPinnedMeetingSelectionRef.current && currentStillExists) return current;
          if (autoMeeting) return autoMeeting.id;
          if (currentStillExists) return current;
          return preferred?.id ?? null;
        });
        if (firstLoad) {
          setShowCreateForm(result.length === 0);
          setConnection(preferred?.status === "active" ? "connecting" : "disconnected");
          setConnectionMessage(preferred?.audio_source === "desktop_auto"
            ? "Automatic meeting capture detected. Loading live context…"
            : preferred?.status === "active"
              ? "Connecting to the selected meeting..."
              : "Create a session or enable the Contexa Contexa Desktop app.");
          setSessionMessage("");
          firstLoad = false;
        } else if (autoMeeting) {
          setConnectionMessage("Automatic meeting capture is active for this meeting.");
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not load meeting sessions.";
          setSessionMessage(`${message} Check that the API and database are running.`);
        }
      } finally {
        if (!cancelled && isFirstLoad) setMeetingsLoading(false);
      }
    }

    void loadMeetings();
    const interval = window.setInterval(() => void loadMeetings(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const desktop = window.contexaDesktop;
    if (!isDesktopApp || !desktop?.onTranscript || !selectedMeetingId) return;

    // Desktop auto-capture owns a separate backend WebSocket from the renderer.
    // Subscribe to its IPC transcript events so interim Deepgram results can drive
    // the green live-preview card; finalized segments are also reflected immediately
    // and remain reconciled with the regular database transcript polling.
    const unsubscribe = desktop.onTranscript((payload) => {
      const message = payload as ServerMessage;
      if (
        message.type !== "transcript.segment"
        || message.meeting_id !== selectedMeetingId
        || !message.segment
      ) return;

      const segment = message.segment;
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
      } else {
        setInterimTranscript(segment);
      }
    });

    return unsubscribe;
  }, [selectedMeetingId]);

  useEffect(() => {
    if (!isDesktopApp || !window.contexaDesktop) return;
    let cancelled = false;

    async function refreshDesktopStatus() {
      try {
        const status = await window.contexaDesktop?.getStatus();
        if (!cancelled && status) setDesktopStatus(status);
      } catch (error) {
        if (!cancelled) setDesktopActionMessage(error instanceof Error ? error.message : "Could not read desktop capture status.");
      }
    }

    void refreshDesktopStatus();
    const interval = window.setInterval(() => void refreshDesktopStatus(), 2500);
    return () => { cancelled = true; window.clearInterval(interval); };
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
    // The Electron window can appear while Docker/FastAPI are still starting. Retry
    // the local status endpoint so the UI recovers instead of remaining stuck at setup.
    const interval = window.setInterval(() => void loadTranscriptionStatus(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadMemoryStatus() {
      try {
        const response = await fetch(`${API_BASE}/api/memory/status`);
        if (!response.ok) throw new Error(await responseError(response));
        const result = (await response.json()) as { configured: boolean; model?: string; message?: string; schema_ready?: boolean; automatic_extraction?: boolean; extraction_timing?: string };
        if (cancelled) return;
        setMemoryConfigured(result.configured);
        if (!result.configured) setMemoryMessage(result.message || "Structured memory is not configured.");
      } catch {
        if (!cancelled) {
          setMemoryConfigured(false);
          setMemoryMessage("Could not check structured-memory provider status.");
        }
      }
    }

    void loadMemoryStatus();
    const interval = window.setInterval(() => void loadMemoryStatus(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedMeetingId) return () => { cancelled = true; };

    async function loadTranscript() {
      try {
        const response = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId!)}/transcript`);
        if (!response.ok) throw new Error(await responseError(response));
        const segments = (await response.json()) as TranscriptSegment[];
        if (cancelled) return;
        // Polling lets the workspace receive transcript segments produced by the
        // separate background companion process, while remaining compatible with
        // the browser's own WebSocket-driven capture mode.
        setTranscriptSegments(segments);
      } catch (error) {
        if (!cancelled) {
          const detail = error instanceof Error ? error.message : "Unknown error";
          setCaptureMessage(`Could not load this meeting's saved transcript: ${detail}`);
        }
      }
    }

    void loadTranscript();
    const interval = selectedMeetingStatus === "active"
      ? window.setInterval(() => void loadTranscript(), 1800)
      : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [selectedMeetingId, selectedMeetingStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedMeetingId) return () => { cancelled = true; };

    async function loadMemory() {
      try {
        const response = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId!)}/memory`);
        if (response.ok) {
          const items = (await response.json()) as MemoryItem[];
          if (!cancelled) setMemoryItems(items);
        }
        // Poll the post-meeting job separately so the user can see progress/failure
        // without opening server logs or clicking the extraction button.
        const statusResponse = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId!)}/memory/status`);
        if (statusResponse.ok) {
          const job = (await statusResponse.json()) as { status?: string; message?: string };
          if (!cancelled && job.status && job.status !== "not_started" && job.message) {
            setMemoryMessage(job.message);
          }
        }
      } catch {
        // Keep last known memory visible during brief local API restarts.
      }
    }
    void loadMemory();
    // Keep refreshing during the post-meeting extraction window. The backend runs
    // one batched Groq extraction after the session is ended, then this effect stops.
    const shouldPoll = selectedMeetingStatus === "active" || selectedMeetingStatus === "ended";
    const interval = shouldPoll ? window.setInterval(() => void loadMemory(), 2500) : null;
    const endedPollTimeout = selectedMeetingStatus === "ended" && interval !== null
      ? window.setTimeout(() => window.clearInterval(interval), 45000)
      : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
      if (endedPollTimeout !== null) window.clearTimeout(endedPollTimeout);
    };
  }, [selectedMeetingId, selectedMeetingStatus]);

  useEffect(() => {
    if (activeTab !== "transcript" || !focusTranscriptSegmentId) return;
    const target = document.getElementById(`transcript-segment-${focusTranscriptSegmentId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("transcript-segment-focused");
    const timeout = window.setTimeout(() => {
      target.classList.remove("transcript-segment-focused");
      setFocusTranscriptSegmentId(null);
    }, 1800);
    return () => window.clearTimeout(timeout);
  }, [activeTab, focusTranscriptSegmentId, transcriptSegments]);

  useEffect(() => {
    let cancelled = false;

    async function checkBackend() {
      try {
        const response = await fetch(`${API_BASE}/health`, { cache: "no-store" });
        if (!response.ok) throw new Error("Backend health check failed.");
        if (!cancelled) setBackendHealth("online");
      } catch {
        if (!cancelled) setBackendHealth("offline");
      }
    }

    void checkBackend();
    const interval = window.setInterval(() => void checkBackend(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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
          setCaptureMessage(`Connected to ${message.provider ?? transcriptionProvider} streaming transcription (${message.model ?? "configured model"}). Waiting for audible speech from the selected source.`);
          break;
        case "transcript.segment": {
          firstTranscriptReceivedRef.current = true;
          if (firstTranscriptTimeoutRef.current !== null) {
            window.clearTimeout(firstTranscriptTimeoutRef.current);
            firstTranscriptTimeoutRef.current = null;
          }
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
        case "audio.chunk.received": {
          setAudioChunksAcknowledged((count) => count + 1);
          const byteLength = message.byte_length ?? 0;
          // Tiny WebM chunks are often silence/near-silence. They are a warning sign,
          // not definitive proof, so keep capture active and explain the selected source.
          smallAudioAckCountRef.current = byteLength <= 400 ? smallAudioAckCountRef.current + 1 : 0;
          if (!firstTranscriptReceivedRef.current && smallAudioAckCountRef.current >= 6) {
            setCaptureMessage(
              captureSourceAtStartRef.current === "desktop"
                ? "Audio chunks are reaching Deepgram, but they are almost silent and no words have returned. Desktop mode excludes your physical mic. Make sure sound is playing through the selected Zoom window; to test your mic, stop and select Microphone only."
                : captureSourceAtStartRef.current === "tab"
                  ? "Audio chunks are reaching Deepgram, but they are almost silent and no words have returned. Check that the selected meeting tab is playing audible audio and tab-audio sharing is enabled."
                  : "Audio chunks are reaching Deepgram, but they are almost silent and no words have returned. Check Windows microphone privacy, the selected input device, and the microphone meter."
            );
          } else {
            setCaptureMessage(`Audio forwarded to ${transcriptionProvider} (${byteLength} bytes). Waiting for transcript…`);
          }
          break;
        }
        case "memory.status":
          setMemoryConfigured(Boolean(message.configured));
          if (message.message && !message.configured) setMemoryMessage(message.message);
          break;
        case "memory.items": {
          if (message.meeting_id !== selectedMeetingId || !Array.isArray(message.items)) break;
          setMemoryItems((current) => {
            const byId = new Map(current.map((item) => [item.id, item]));
            for (const item of message.items ?? []) byId.set(item.id, item);
            return [...byId.values()].sort((a, b) => a.start_seconds - b.start_seconds);
          });
          setMemoryMessage(`${message.item_count ?? message.items.length} structured memory item(s) updated from the transcript.`);
          break;
        }
        case "memory.processed":
          setMemoryMessage(`Structured memory checked ${message.processed_segments ?? 0} transcript segment(s); ${message.item_count ?? 0} item(s) created or updated.`);
          break;
        case "memory.error":
          setMemoryMessage(message.message ?? "Structured memory extraction failed.");
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

  function selectMeeting(nextId: string | null) {
    userPinnedMeetingSelectionRef.current = true;
    const nextMeeting = meetings.find((meeting) => meeting.id === nextId) ?? null;
    setShowCreateForm(false);
    setSessionMessage("");
    setTranscriptSegments([]);
    setInterimTranscript(null);
    setSelectedMeetingId(nextId);
    setConsentConfirmed(false);
    setActiveTab("transcript");
    setConnection(nextMeeting?.status === "active" ? "connecting" : "disconnected");
    setConnectionMessage(
      nextMeeting?.status === "active"
        ? "Connecting to the selected meeting…"
        : "This meeting is saved. Select an active meeting to connect.",
    );
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
      userPinnedMeetingSelectionRef.current = true;
      setMeetings((current) => [created, ...current]);
      setSelectedMeetingId(created.id);
      setConnection("connecting");
      setConnectionMessage("Connecting to the new meeting session...");
      setNewMeetingTitle("");
      setShowCreateForm(false);
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
      if (selectedMeeting.audio_source === 'desktop_auto') {
        const desktop = window.contexaDesktop;
        if (!desktop?.endAutoCapturedMeeting) {
          throw new Error('The desktop capture controller is unavailable. Restart Contexa and try again.');
        }
        const desktopResult = await desktop.endAutoCapturedMeeting(selectedMeeting.id);
        if (!desktopResult.ok) throw new Error(desktopResult.message || 'Could not stop desktop meeting capture.');
        setDesktopStatus(desktopResult.status);
      }
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
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
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
          : "Capture stopped. Audio was streamed to Deepgram; finalized transcript segments are saved, and raw audio is not stored.",
      );
    } catch {
      setCaptureMessage("Capture stopped, but some queued audio could not be delivered.");
    } finally {
      if (firstChunkTimeoutRef.current !== null) {
        window.clearTimeout(firstChunkTimeoutRef.current);
        firstChunkTimeoutRef.current = null;
      }
      if (firstTranscriptTimeoutRef.current !== null) {
        window.clearTimeout(firstTranscriptTimeoutRef.current);
        firstTranscriptTimeoutRef.current = null;
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
      audioSource === "microphone"
        ? "Requesting microphone permission. Microphone-only mode can capture room sounds."
        : audioSource === "desktop"
          ? "Choose the meeting application window. Meeting audio and your microphone use separate channels; window-audio support varies by browser."
          : "Choose the meeting browser tab and enable Share tab audio. Meeting audio and your microphone are kept on separate channels.",
    );

    let sourceStream: MediaStream | null = null;
    let microphoneStream: MediaStream | null = null;
    let composedStream: MediaStream | null = null;
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

      if (audioSource === "tab" || audioSource === "desktop") {
        if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
          throw new Error("This browser does not support tab/screen capture. Try current Chrome or Edge.");
        }
        // These options are hints; browser support varies. Prefer selected-window audio,
        // and explicitly exclude entire-system audio so unrelated notifications/music
        // are not silently captured. Do not fall back to the physical microphone.
        const displayCaptureOptions: DisplayMediaStreamOptions & {
          systemAudio?: "exclude";
          windowAudio?: "window";
          selfBrowserSurface?: "exclude";
        } = {
          video: true,
          audio: true,
          systemAudio: "exclude",
          windowAudio: "window",
          selfBrowserSurface: "exclude",
        };
        sourceStream = await navigator.mediaDevices.getDisplayMedia(displayCaptureOptions);
        if (audioSource === "desktop") {
          const selectedSurface = sourceStream.getVideoTracks()[0]?.getSettings().displaySurface;
          // Browser fallback is fail-closed: only accept a browser-confirmed window.
          if (selectedSurface !== "window") {
            sourceStream.getTracks().forEach((track) => track.stop());
            sourceStream = null;
            throw new Error("For meeting-only browser fallback, select the meeting application window—not Entire Screen. Automatic per-application capture is provided by the Contexa Windows desktop app.");
          }
        }
        // Browser capture needs one permission action per session. Mix the meeting
        // source and the local mic so the transcript includes both remote participants
        // and the user. Echo cancellation/noise suppression reduce speaker bleed.
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
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

      const sourceAudioTracks = sourceStream.getAudioTracks();
      if (sourceAudioTracks.length === 0) {
        sourceStream.getTracks().forEach((track) => track.stop());
        microphoneStream?.getTracks().forEach((track) => track.stop());
        sourceStream = null;
        microphoneStream = null;
        setCaptureMessage(
          audioSource === "desktop"
            ? "The browser did not return audio for that window. Use the Contexa Windows desktop app for reliable app-specific audio capture."
            : audioSource === "tab"
              ? 'The browser picker returned no audio track. Choose the meeting tab and enable "Share tab audio".'
              : "The browser returned no microphone audio track. Check site permissions and that an input device is connected.",
        );
        return;
      }

      let audioTracks: MediaStreamTrack[] = sourceAudioTracks;
      if ((audioSource === "tab" || audioSource === "desktop") && microphoneStream) {
        if (microphoneStream.getAudioTracks().length === 0) {
          throw new Error("Microphone permission was granted but the browser returned no microphone audio track.");
        }
        const audioContext = new AudioContext({ latencyHint: "interactive" });
        audioContextRef.current = audioContext;
        const destination = audioContext.createMediaStreamDestination();
        // Preserve provenance as two independent audio channels instead of mixing
        // the user's microphone into the remote meeting audio. Channel 0 is the
        // selected tab/window; channel 1 is the local microphone.
        destination.channelCount = 2;
        destination.channelCountMode = "explicit";
        destination.channelInterpretation = "discrete";
        const merger = audioContext.createChannelMerger(2);
        const connectMonoInput = (stream: MediaStream, gain: number, destinationChannel: number) => {
          const sourceNode = audioContext.createMediaStreamSource(stream);
          sourceNode.channelCount = 1;
          sourceNode.channelCountMode = "explicit";
          const gainNode = audioContext.createGain();
          gainNode.gain.value = gain;
          sourceNode.connect(gainNode).connect(merger, 0, destinationChannel);
        };
        connectMonoInput(new MediaStream(sourceAudioTracks), 0.9, 0);
        connectMonoInput(new MediaStream(microphoneStream.getAudioTracks()), 0.8, 1);
        merger.connect(destination);
        await audioContext.resume();
        composedStream = destination.stream;
        audioTracks = composedStream.getAudioTracks();
      }

      const selectedTrack = audioTracks[0];
      if (!selectedTrack || selectedTrack.readyState !== "live" || !selectedTrack.enabled) {
        sourceStream.getTracks().forEach((track) => track.stop());
        sourceStream = null;
        setCaptureMessage("The selected audio source is not live or is disabled. Check the selected audio source and retry.");
        return;
      }

      captureStreamsRef.current = [sourceStream, ...(microphoneStream ? [microphoneStream] : []), ...(composedStream ? [composedStream] : [])];
      captureSourceAtStartRef.current = audioSource;
      setAudioChunksSent(0);
      setAudioChunksAcknowledged(0);
      sendQueueRef.current = Promise.resolve();
      audioDeliveryFailedRef.current = false;
      captureFinalizingRef.current = false;
      firstAudioChunkReceivedRef.current = false;
      firstTranscriptReceivedRef.current = false;
      smallAudioAckCountRef.current = 0;

      setCaptureMessage(
        `Audio device ready (${selectedTrack.label || "audio track"}). Initializing recorder…`,
      );

      // Only audio tracks are recorded/sent. For tab/window mode, audioTracks is the
      // WebAudio mix of the meeting source plus the user's microphone.
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
          setCaptureMessage(audioSource === "desktop" ? "The selected meeting window is currently producing no audio, or this browser cannot capture its output. Check the window audio-sharing option." : audioSource === "microphone" ? "Recorder emitted an empty chunk. Check that the microphone is not muted and the input meter is moving." : "The selected browser tab is not producing captured audio. Check Share tab audio.");
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
      captureStreamsRef.current.forEach((captureStream) => {
        captureStream.getTracks().forEach((track) => {
          track.addEventListener("ended", () => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
              void stopCapture();
            }
          }, { once: true });
        });
      });

      const splitSourceChannels = (audioSource === "tab" || audioSource === "desktop") && Boolean(microphoneStream);
      if (!sendMessage({
        type: "audio.start",
        source: audioSource,
        mime_type: recorder.mimeType,
        channels: splitSourceChannels ? 2 : 1,
        multichannel: splitSourceChannels,
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
      firstTranscriptTimeoutRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current === recorder && recorder.state === "recording" && !firstTranscriptReceivedRef.current) {
          setCaptureMessage(
            audioSource === "desktop"
              ? "Deepgram is connected but has returned no transcript yet. The logs show desktop mode, which does not capture your physical mic. Check that audible Zoom output is coming from the selected window; choose Microphone only to test your mic."
              : audioSource === "tab"
                ? "Deepgram is connected but has returned no transcript yet. Verify that the selected meeting tab is playing audio and Share tab audio is enabled."
                : "Deepgram is connected but has returned no transcript yet. Check the selected microphone in Windows sound settings and ensure its input meter moves while you speak."
          );
        }
      }, 12000);
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
            audioSource === "desktop"
              ? `Recorder is active but no window-audio chunk has arrived after 5 seconds (${trackInfo}). Check the Zoom window's audio-sharing option and browser/OS support.`
              : `Recorder is active but no audio chunk has arrived after 5 seconds (${trackInfo}). Check the selected audio source and its permissions.`,
          );
        }
      }, 5000);
    } catch (error: unknown) {
      if (firstChunkTimeoutRef.current !== null) {
        window.clearTimeout(firstChunkTimeoutRef.current);
        firstChunkTimeoutRef.current = null;
      }
      if (firstTranscriptTimeoutRef.current !== null) {
        window.clearTimeout(firstTranscriptTimeoutRef.current);
        firstTranscriptTimeoutRef.current = null;
      }
      sourceStream?.getTracks().forEach((track) => track.stop());
      microphoneStream?.getTracks().forEach((track) => track.stop());
      composedStream?.getTracks().forEach((track) => track.stop());
      captureStreamsRef.current = [];
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close().catch(() => undefined);
      }
      audioContextRef.current = null;
      mediaRecorderRef.current = null;
      setCaptureActive(false);

      const name = error instanceof DOMException ? error.name : "";
      const detail = error instanceof Error ? error.message : "Unknown capture error.";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCaptureMessage("Permission was denied or blocked. Allow the selected window/tab or microphone source in browser permissions, then retry.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCaptureMessage(audioSource === "desktop" ? "The selected meeting-window audio source was not found. Choose the Zoom window and retry." : "No microphone/input device was found. Connect or enable a microphone and retry.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setCaptureMessage(audioSource === "desktop" ? "The browser could not read audio from that window. Check browser/OS support for window audio and retry." : "The microphone exists but cannot be read. Check Windows microphone privacy settings and close other apps using it.");
      } else if (name === "AbortError") {
        setCaptureMessage("Audio capture was interrupted by the browser. Retry and keep the capture picker open until selection completes.");
      } else {
        setCaptureMessage(`Could not start audio capture (${name || "error"}): ${detail}`);
      }
    } finally {
      setCaptureStarting(false);
    }
  }

  async function submitMeetingQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = chatQuestion.trim();
    if (!selectedMeetingId || !question || chatSending) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`, role: "user", content: question, scope: chatScope,
    };
    const previousMessages = chatMeetingId === selectedMeetingId ? chatMessages : [];
    setChatMeetingId(selectedMeetingId);
    setChatMessages([...previousMessages, userMessage]);
    setChatQuestion("");
    setChatSending(true);
    try {
      const response = await fetch(`${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId)}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          scope: chatScope,
          history: previousMessages.slice(-6).map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as {
        meeting_answer: string;
        broader_context: string | null;
        evidence: ChatEvidence[];
        scope: "meeting" | "broader";
      };
      setChatMessages((messages) => [...messages, {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: result.meeting_answer,
        broaderContext: result.broader_context,
        evidence: result.evidence,
        scope: result.scope,
      }]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      setChatMessages((messages) => [...messages, {
        id: `assistant-error-${Date.now()}`,
        role: "assistant",
        content: `I couldn't answer that yet. ${detail}`,
        scope: chatScope,
        error: true,
      }]);
    } finally {
      setChatSending(false);
    }
  }

  function openChatEvidence(evidence: ChatEvidence) {
    const target = transcriptSegments.find((segment) => segment.id === evidence.segment_id);
    if (target) setFocusTranscriptSegmentId(target.id);
    setActiveTab("transcript");
  }

  async function extractSavedMemory() {
    if (!selectedMeetingId || extractingMemory) return;
    if (!memoryConfigured) {
      setMemoryMessage(memoryMessage || "Check GROQ_API_KEY and the memory database migration status, then restart FastAPI.");
      return;
    }

    setExtractingMemory(true);
    setMemoryMessage("Extracting structured memory from saved transcript segments…");
    try {
      const response = await fetch(
        `${API_BASE}/api/meetings/${encodeURIComponent(selectedMeetingId)}/memory/extract`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as {
        processed_segments: number;
        item_count: number;
        items: MemoryItem[];
      };
      setMemoryItems(result.items);
      setMemoryMessage(
        `Processed ${result.processed_segments} transcript segment(s); ${result.item_count} structured memory item(s) are saved.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown extraction error.";
      setMemoryMessage(`Memory extraction failed: ${detail}`);
    } finally {
      setExtractingMemory(false);
    }
  }

  function openTranscriptEvidence(item: MemoryItem) {
    const sourceSegment = transcriptSegments.find((segment) => item.source_segment_ids.includes(segment.id));
    const fallbackSegment = transcriptSegments.reduce<TranscriptSegment | null>((closest, segment) => {
      if (!closest) return segment;
      return Math.abs(segment.start_seconds - item.start_seconds) < Math.abs(closest.start_seconds - item.start_seconds)
        ? segment
        : closest;
    }, null);
    const target = sourceSegment ?? fallbackSegment;
    if (target) setFocusTranscriptSegmentId(target.id);
    setActiveTab("transcript");
  }

  async function toggleDesktopAutoCapture() {
    const desktop = window.contexaDesktop;
    if (!desktop || desktopBusy) return;
    setDesktopBusy(true);
    setDesktopActionMessage("");
    try {
      const result = desktopStatus?.autoCaptureEnabled
        ? await desktop.pauseAutoCapture()
        : await desktop.enableAutoCapture();
      setDesktopStatus(result.status);
      setDesktopActionMessage(result.message);
    } catch (error) {
      setDesktopActionMessage(error instanceof Error ? error.message : "Could not update Auto Capture.");
      try { setDesktopStatus(await desktop.getStatus()); } catch { /* best effort refresh */ }
    } finally {
      setDesktopBusy(false);
    }
  }

  const isAutoCaptureSession = selectedMeeting?.audio_source === "desktop_auto";
  const isAutoCaptureEnabled = isDesktopApp && desktopStatus?.autoCaptureEnabled === true;
  const isMeetingCapturing = captureActive || isAutoCaptureSession || desktopStatus?.captureActive === true;
  const decisionItems = selectedMemoryItems.filter((item) => ["decision", "open_question", "action_item", "argument"].includes(item.item_type));
  const confirmedDecisionItems = selectedMemoryItems.filter((item) => item.item_type === "decision");
  const actionItems = selectedMemoryItems.filter((item) => item.item_type === "action_item");
  const unresolvedItems = selectedMemoryItems.filter((item) => item.item_type === "open_question");
  const topicItems = selectedMemoryItems.filter((item) => ["topic", "fact"].includes(item.item_type));
  const catchupItems = selectedMemoryItems.filter((item) => ["decision", "proposal", "action_item", "open_question"].includes(item.item_type)).slice(-8).reverse();
  // Count meaningful speaker sources without counting unknown/null speaker IDs.
  // A dedicated microphone channel is counted as one local speaker.
  const speakerCount = new Set(
    transcriptSegments.map((segment) => {
      if (segment.audio_channel === 1) return "local-microphone";
      if (segment.audio_channel === 0) return `meeting-speaker-${segment.speaker_id ?? "unknown"}`;
      return segment.speaker_id === null ? null : `speaker-${segment.speaker_id}`;
    }).filter((speaker): speaker is string => speaker !== null),
  ).size;
  const overviewHighlights = [...selectedMemoryItems]
    .filter((item) => ["decision", "action_item", "open_question", "topic", "proposal"].includes(item.item_type))
    .sort((a, b) => {
      const priority: Partial<Record<MemoryItemType, number>> = {
        decision: 0,
        action_item: 1,
        open_question: 2,
        proposal: 3,
        topic: 4,
      };
      return (priority[a.item_type] ?? 5) - (priority[b.item_type] ?? 5)
        || a.start_seconds - b.start_seconds;
    })
    .slice(0, 3);
  const meetingDurationSeconds = transcriptSegments.reduce((max, segment) => Math.max(max, segment.end_seconds), 0);
  const formatDuration = (seconds: number) => seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : `${Math.floor(seconds / 60)}m`;
  const transcriptDuration = transcriptSegments.length ? formatDuration(meetingDurationSeconds) : "—";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Contexa home">
          <span className="brand-mark"><span>C</span></span>
          <span className="brand-wordmark">contexa</span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>
        <button className="nav-item active" type="button" aria-current="page">
          <span className="nav-icon" aria-hidden="true">⌂</span>
          <span>Overview</span>
          <span className="nav-active-marker" />
        </button>

        <div className="sidebar-section-label sidebar-history-heading">
          <span>MEETING HISTORY</span>
          <span className="nav-count">{meetings.length}</span>
        </div>
        <button
          className="sidebar-new-meeting"
          type="button"
          onClick={() => {
            userPinnedMeetingSelectionRef.current = true;
            setShowCreateForm(true);
            setSessionMessage("Name your new meeting.");
            window.setTimeout(() => newMeetingInputRef.current?.focus(), 0);
          }}
        >
          <span aria-hidden="true">＋</span> New meeting
        </button>
        <div className="sidebar-meetings-list" aria-label="Meeting history">
          {meetingsLoading && meetings.length === 0 && (
            <p className="sidebar-empty-history">Loading meetings…</p>
          )}
          {!meetingsLoading && meetings.length === 0 && (
            <p className="sidebar-empty-history">No meetings yet</p>
          )}
          {meetings.map((meeting) => (
            <button
              key={meeting.id}
              type="button"
              className={`sidebar-meeting-item ${selectedMeetingId === meeting.id ? "selected" : ""}`}
              onClick={() => selectMeeting(meeting.id)}
              title={meeting.title}
            >
              <span className={`sidebar-meeting-state ${meeting.status === "active" ? "is-active" : ""}`} />
              <span className="sidebar-meeting-text">
                <span className="sidebar-meeting-title">{meeting.title}</span>
                <span className="sidebar-meeting-meta">
                  {meeting.status === "active" ? "In progress" : formatMeetingDate(meeting.created_at)}
                </span>
              </span>
            </button>
          ))}
        </div>

        {isDesktopApp && (
          <div className="sidebar-capture-card">
            <div className="capture-card-topline">
              <span className={`capture-indicator ${isMeetingCapturing || isAutoCaptureEnabled ? "active" : ""}`} />
              <span>AUTO CAPTURE</span>
            </div>
            <strong>{isMeetingCapturing ? "Capturing meeting" : isAutoCaptureEnabled ? "Monitoring for meetings" : "Paused"}</strong>
            <button
              className={`capture-toggle-button ${desktopStatus?.autoCaptureEnabled ? "toggle-enabled" : ""}`}
              type="button"
              onClick={() => void toggleDesktopAutoCapture()}
              disabled={!desktopStatus || desktopBusy}
            >
              {desktopBusy ? "Updating…" : desktopStatus?.autoCaptureEnabled ? "Pause" : "Enable"}
            </button>
            {desktopStatus?.lastCaptureError && <p className="capture-card-error">{desktopStatus.lastCaptureError}</p>}
            {desktopActionMessage && <p className="capture-card-action-message" role="status">{desktopActionMessage}</p>}
            <div className="capture-card-footer"><span className="privacy-shield">◇</span> Raw audio not saved locally</div>
          </div>
        )}

      </aside>

      <main className="main-area" id="home">
        <header className="topbar">
          <div className="topbar-right">
            <span className={`connection-pill ${backendHealth === "online" ? "online" : backendHealth === "checking" ? "connecting" : "disconnected"}`}>
              <span className="status-dot" />
              {backendHealth === "online" ? "Online" : backendHealth === "checking" ? "Checking…" : "Offline"}
            </span>
            <span className="environment-tag"><span className="environment-dot" />{isDesktopApp ? "DESKTOP" : "WEB"}</span>
          </div>
        </header>

        <div className="workspace">
          <section className="meeting-column">
            <div className="meeting-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" />MEETING</div>
                <h1>{selectedMeeting?.title ?? "Your meetings"}</h1>
                <p className="meeting-subtitle">
                  {selectedMeeting
                    ? `${selectedMeeting.status === "active" ? "In progress" : "Completed"} · ${formatMeetingDate(selectedMeeting.created_at)}`
                    : "Choose a meeting from history or create a new one."}
                </p>
              </div>
            </div>

            {showCreateForm && (
              <section className="session-manager surface-card create-meeting-panel" aria-label="Create meeting">
                <form className="session-create-form" onSubmit={createMeeting}>
                  <label className="sr-only" htmlFor="new-meeting-title">Meeting name</label>
                  <div className="session-create-row">
                    <input
                      ref={newMeetingInputRef}
                      id="new-meeting-title"
                      value={newMeetingTitle}
                      onChange={(event) => setNewMeetingTitle(event.target.value)}
                      placeholder="Meeting name"
                      maxLength={200}
                      required
                      disabled={creatingMeeting || captureActive || captureStarting}
                    />
                    <button type="submit" disabled={creatingMeeting || captureActive || captureStarting || !newMeetingTitle.trim()}>
                      {creatingMeeting ? "Creating…" : "Create meeting"}
                    </button>
                    <button className="create-cancel-button" type="button" onClick={() => { setShowCreateForm(false); setSessionMessage(""); }}>Cancel</button>
                  </div>
                </form>
                {sessionMessage && <p className="session-message" role="status">{sessionMessage}</p>}
              </section>
            )}

            {selectedMeeting?.status === "active" && (
              <div className="active-session-strip">
                <span><span className="status-dot" /> Meeting in progress</span>
                <button className="end-session-button" type="button" onClick={() => void endMeeting()} disabled={captureStarting || (captureActive && !mediaRecorderRef.current)}>
                  End meeting
                </button>
              </div>
            )}

            {sessionMessage && !showCreateForm && <p className="session-message" role="status">{sessionMessage}</p>}

            {selectedMeeting && (
              <section className="meeting-overview" aria-label="Meeting overview">
                <div className="overview-section-heading">
                  <div><span className="overview-eyebrow">OVERVIEW</span><h2>Meeting at a glance</h2></div>
                  <span className={`overview-source-pill ${selectedMeeting.status === "active" ? "is-live" : ""}`}>
                    {selectedMeeting.status === "active" ? "Live" : "Saved"}
                  </span>
                </div>

                <div className="overview-metrics" aria-label="Meeting metrics">
                  <div className="overview-metric">
                    <span className="overview-metric-icon metric-icon-duration" aria-hidden="true">◷</span>
                    <span className="overview-metric-copy"><span>Duration</span><strong>{transcriptDuration}</strong></span>
                  </div>
                  <div className="overview-metric">
                    <span className="overview-metric-icon metric-icon-speakers" aria-hidden="true">♟</span>
                    <span className="overview-metric-copy"><span>Speakers</span><strong>{speakerCount}</strong></span>
                  </div>
                  <div className="overview-metric">
                    <span className="overview-metric-icon metric-icon-transcript" aria-hidden="true">≋</span>
                    <span className="overview-metric-copy"><span>Transcript</span><strong>{transcriptSegments.length}</strong></span>
                  </div>
                  <div className="overview-metric">
                    <span className="overview-metric-icon metric-icon-memory" aria-hidden="true">✳</span>
                    <span className="overview-metric-copy"><span>Memory</span><strong>{selectedMemoryItems.length}</strong></span>
                  </div>
                </div>

                <section className="overview-card overview-highlights-card">
                  <div className="overview-card-heading">
                    <div><h3>Meeting summary</h3><p>Key points grounded in the saved discussion</p></div>
                    <button type="button" className="text-action" onClick={() => setActiveTab("memory")}>View memory <span>→</span></button>
                  </div>
                  {overviewHighlights.length > 0 ? (
                    <div className="overview-highlight-list">
                      {overviewHighlights.map((item) => (
                        <button className="overview-highlight-row" key={item.id} type="button" onClick={() => openTranscriptEvidence(item)} title="Open supporting transcript">
                          <span className={`overview-item-mark overview-mark-${item.item_type}`} />
                          <span className="overview-highlight-copy"><strong>{item.title}</strong><span>{item.content}</span></span>
                          <span className="overview-highlight-time">{formatTranscriptTime(item.start_seconds)} <span aria-hidden="true">↗</span></span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="overview-empty-state">
                      <strong>{transcriptSegments.length ? "Meeting memory is still being prepared" : "No meeting content yet"}</strong>
                      <p>{transcriptSegments.length ? "Your transcript is saved. Highlights will appear when structured memory is available." : "Start a supported meeting to see its transcript, summary and follow-ups here."}</p>
                      {selectedMeeting.status === "ended" && transcriptSegments.length > 0 && memoryConfigured && <button type="button" className="text-action" onClick={() => setActiveTab("memory")}>View memory status <span>→</span></button>}
                    </div>
                  )}
                </section>

                <div className="overview-cards-grid">
                  <OverviewListCard
                    title="Decisions"
                    count={confirmedDecisionItems.length}
                    items={confirmedDecisionItems}
                    emptyText="No decisions recorded"
                    onViewAll={() => setActiveTab("decisions")}
                    onOpenEvidence={openTranscriptEvidence}
                  />
                  <OverviewListCard
                    title="Action items"
                    count={actionItems.length}
                    items={actionItems}
                    emptyText="No action items recorded"
                    onViewAll={() => setActiveTab("decisions")}
                    onOpenEvidence={openTranscriptEvidence}
                  />
                  <OverviewListCard
                    title="Topics"
                    count={topicItems.filter((item) => item.item_type === "topic").length}
                    items={topicItems.filter((item) => item.item_type === "topic")}
                    emptyText="No topics extracted yet"
                    onViewAll={() => setActiveTab("topic")}
                    onOpenEvidence={openTranscriptEvidence}
                    wide
                  />
                </div>

                {unresolvedItems.length > 0 && (
                  <section className="overview-open-questions">
                    <div className="overview-card-heading"><h3>Open questions</h3><span>{unresolvedItems.length}</span></div>
                    {unresolvedItems.slice(0, 2).map((item) => (
                      <button className="overview-open-question-row" key={item.id} type="button" onClick={() => openTranscriptEvidence(item)}>
                        <span>{item.title}</span><span>{formatTranscriptTime(item.start_seconds)} ↗</span>
                      </button>
                    ))}
                  </section>
                )}
              </section>
            )}

            <details className="manual-capture-details">
              <summary>
                <span className="manual-summary-icon">⌁</span>
                <span><strong>Advanced audio diagnostics</strong><small>Manual capture and troubleshooting</small></span>
                <span className="optional-label">ADVANCED</span>
              </summary>
              <div className="meeting-actions">
                <div className="capture-source-row">
                  <label htmlFor="audio-source">Audio source</label>
                  <select id="audio-source" value={audioSource} onChange={(event) => setAudioSource(event.target.value as AudioSource)} disabled={captureActive}>
                    <option value="tab">Browser meeting tab + my microphone</option>
                    <option value="desktop">Desktop meeting window + my microphone (browser fallback)</option>
                    <option value="microphone">Microphone only (diagnostics; includes room sounds)</option>
                  </select>
                </div>
                <label className="consent-checkbox">
                  <input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} disabled={captureActive} />
                  <span>I have permission to capture this meeting. Audio streams to Deepgram; Contexa doesn't save raw audio.</span>
                </label>
                <div className="action-buttons">
                  <button
                    type="button"
                    className={captureActive ? "stop-capture-button" : "start-capture-button"}
                    onClick={() => captureActive ? void stopCapture() : void startCapture()}
                    disabled={captureStarting || (captureActive ? false : (effectiveConnection !== "connected" || !selectedMeeting || selectedMeeting.status !== "active" || !consentConfirmed))}
                  >
                    {captureStarting ? "Requesting permission…" : captureActive ? "■ Stop capture" : "Start manual capture"}
                  </button>
                  <span className="controls-note">{captureActive ? `${audioChunksSent} sent · ${audioChunksAcknowledged} received` : "Browser permissions are required."}</span>
                </div>
                <div className={`capture-status ${captureActive ? "is-active" : captureStarting ? "is-pending" : ""}`} role="status" aria-live="polite">
                  <span className="capture-status-dot" aria-hidden="true" />
                  <div><strong>{captureActive ? "Capture active" : captureStarting ? "Waiting for permission" : "Capture inactive"}</strong><p>{captureMessage}</p></div>
                </div>
              </div>
            </details>
          </section>

          <aside className="copilot-panel">
            <div className="copilot-heading">
              <div className="copilot-avatar"><span>C</span></div>
              <div className="copilot-title"><h2>Meeting context</h2></div>
              <span className={`mini-status ${selectedMeeting?.status === "ended" ? "saved" : effectiveConnection}`}>
                <span className="status-dot" />
                {selectedMeeting?.status === "ended" ? "Saved" : !selectedMeeting ? "No meeting" : effectiveConnection === "connected" ? "Live" : effectiveConnection === "connecting" ? "Connecting" : "Waiting"}
              </span>
            </div>
            <div className="copilot-tabs" role="tablist" aria-label="Meeting context views">
              {tabs.map((tab) => <button key={tab.id} id={`tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="copilot-content" className={activeTab === tab.id ? "selected" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
            </div>
            <section className={`copilot-content panel-${activeTab}`} id="copilot-content" role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
              {activeTab === "ask" && <div className="tab-content chat-tab-content">
                <div className="content-heading chat-heading">
                  <div><h3>Ask Contexa</h3></div>
                  <span className="preview-tag ready-tag">Q&amp;A</span>
                </div>
                {!selectedMeetingId && <div className="transcript-empty"><span className="empty-symbol">✦</span><strong>Select a meeting to ask questions</strong><p>Choose a saved meeting or create one from the sidebar.</p></div>}
                {selectedMeetingId && visibleChatMessages.length === 0 && <div className="chat-welcome">
                  <div className="chat-welcome-icon" aria-hidden="true">✦</div>
                  <h4>Your meeting, answerable</h4>
                  <p>Ask what was decided, what someone said, or what an unfamiliar term means.</p>
                  <div className="chat-suggestions">
                    <button type="button" onClick={() => setChatQuestion("Summarize the most important points from this meeting.")}>Summarize this meeting</button>
                    <button type="button" onClick={() => setChatQuestion("What decisions and action items were explicitly recorded?")}>Decisions &amp; action items</button>
                    <button type="button" onClick={() => { setChatScope("broader"); setChatQuestion("Explain the main technical concept discussed and give related background."); }}>Explain a related concept</button>
                  </div>
                </div>}
                <div className="chat-thread" aria-live="polite">
                  {visibleChatMessages.map((message) => <article className={`chat-message chat-${message.role}${message.error ? " chat-error" : ""}`} key={message.id}>
                    <div className="chat-message-label">{message.role === "user" ? "You" : "Contexa"}</div>
                    <p>{message.content}</p>
                    {message.broaderContext && <div className="chat-broader-context"><div className="chat-context-label">Broader context <span>General model knowledge · not live web search</span></div><p>{message.broaderContext}</p></div>}
                    {message.evidence && message.evidence.length > 0 && <div className="chat-evidence"><span>Meeting sources</span>{message.evidence.map((evidence, index) => <button type="button" key={`${message.id}-${evidence.segment_id}-${index}`} onClick={() => openChatEvidence(evidence)}><span>{formatTranscriptTime(evidence.start_seconds)}</span><q>{evidence.quote}</q><span aria-hidden="true">↗</span></button>)}</div>}
                    {message.role === "assistant" && !message.error && message.scope === "meeting" && (!message.evidence || message.evidence.length === 0) && <div className="chat-no-evidence">No matching transcript quote was found for this answer.</div>}
                  </article>)}
                  {chatSending && <div className="chat-thinking"><span className="chat-thinking-dots">•••</span>Checking the meeting context…</div>}
                  <div ref={chatBottomRef} />
                </div>
                <form className="chat-composer" onSubmit={(event) => void submitMeetingQuestion(event)}>
                  <div className="chat-scope-row" role="group" aria-label="Answer scope">
                    <button type="button" className={chatScope === "meeting" ? "active" : ""} onClick={() => setChatScope("meeting")}>Meeting only</button>
                    <button type="button" className={chatScope === "broader" ? "active" : ""} onClick={() => setChatScope("broader")}>Meeting + general context</button>
                  </div>
                  <div className="chat-input-row">
                    <textarea value={chatQuestion} onChange={(event) => setChatQuestion(event.target.value)} placeholder={selectedMeetingId ? "Ask a question about this meeting…" : "Select a meeting first"} rows={2} maxLength={1200} disabled={!selectedMeetingId || chatSending} aria-label="Question for Contexa" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                    <button type="submit" disabled={!selectedMeetingId || !chatQuestion.trim() || chatSending} aria-label="Send question">{chatSending ? "…" : "↑"}</button>
                  </div>
                  <div className="chat-composer-footer"><span>{chatScope === "meeting" ? "Answers use this meeting's transcript and memory." : "General knowledge is labelled separately; no live web search."}</span><span>Enter to send · Shift+Enter for a new line</span></div>
                </form>
              </div>}

              {activeTab === "transcript" && <div className="tab-content">
                <div className="content-heading"><div><h3>Transcript</h3></div><span className={`preview-tag ${transcriptionConfigured ? "ready-tag" : ""}`}>{transcriptionConfigured === true ? "READY" : transcriptionConfigured === false ? "SETUP" : "CHECKING"}</span></div>
                {transcriptionConfigured === false && <div className="transcription-setup-notice"><strong>Transcription needs setup</strong><p>Add <code>DEEPGRAM_API_KEY</code> to the repository-root <code>.env</code> file, then restart Contexa. The key stays on the backend.</p></div>}
                {transcriptSegments.length === 0 && !interimTranscript && <div className="transcript-empty"><span className="empty-symbol">≋</span><strong>No transcript yet</strong><p>Transcript segments will appear here when capture starts.</p></div>}
                {interimTranscript && <div className="interim-transcript"><span className="transcript-live-dot" /><div><div className="transcript-speaker">{interimTranscript.audio_channel === 1 ? "You · microphone · live" : interimTranscript.speaker_id === null ? "Transcribing…" : `Speaker ${interimTranscript.speaker_id + 1} · live`}</div><p>{interimTranscript.text}</p></div></div>}
                {transcriptSegments.map((segment) => <article className="transcript-segment" id={`transcript-segment-${segment.id}`} data-start-seconds={segment.start_seconds} key={segment.id}><time>{formatTranscriptTime(segment.start_seconds)}</time><div className="transcript-segment-body"><div className="transcript-speaker">{segment.audio_channel === 1 ? "You · microphone" : segment.audio_channel === 0 ? (segment.speaker_id === null ? "Meeting participant" : `Meeting speaker ${segment.speaker_id + 1}`) : segment.speaker_id === null ? "Speaker not identified" : `Speaker ${segment.speaker_id + 1}`}</div><p>{segment.text}</p>{segment.words?.length ? <details className="word-timing-details"><summary>Word timing <span>＋</span></summary><div className="word-timing-list">{segment.words.map((word, index) => <span key={`${segment.id}-${index}`}>{word.word} <small>{word.language ? `${word.language} · ` : ""}{typeof word.start === "number" ? formatTranscriptTime(word.start) : ""}</small></span>)}</div></details> : null}</div></article>)}
                {transcriptSegments.length > 0 && <p className="transcript-persistence-note">✓ {transcriptSegments.length} finalized segment{transcriptSegments.length === 1 ? "" : "s"} saved for this meeting.</p>}
              </div>}

              {activeTab === "catchup" && <div className="tab-content">
                <div className="content-heading"><div><h3>Catch me up</h3></div><span className={`preview-tag ${catchupItems.length ? "ready-tag" : ""}`}>{catchupItems.length ? "AVAILABLE" : "EMPTY"}</span></div>
                {catchupItems.length === 0 ? <div className="transcript-empty"><span className="empty-symbol">↺</span><strong>No structured context yet</strong><p>When meeting memory is extracted, proposals, decisions, action items and unresolved questions will appear here.</p><button className="outline-button memory-inline-button" type="button" onClick={() => setActiveTab("memory")}>View meeting memory</button></div> : catchupItems.map((item) => <article className="memory-item-card" key={item.id}><div className="memory-card-top"><span className={`memory-type-tag type-${item.item_type}`}>{item.item_type.replaceAll("_", " ")}</span><time>{formatTranscriptTime(item.start_seconds)}</time></div><h4>{item.title}</h4><p>{item.content}</p><blockquote>{item.evidence_quote}</blockquote></article>)}
              </div>}

              {activeTab === "topic" && <div className="tab-content">
                <div className="content-heading"><div><h3>Current topics</h3></div><span className={`preview-tag ${topicItems.length ? "ready-tag" : ""}`}>{topicItems.length ? `${topicItems.length} ITEMS` : "EMPTY"}</span></div>
                {topicItems.length === 0 ? <div className="transcript-empty"><span className="empty-symbol">⌖</span><strong>No topics extracted yet</strong><p>Topics and facts will appear here after structured memory has been processed.</p><button className="outline-button memory-inline-button" type="button" onClick={() => setActiveTab("memory")}>View meeting memory</button></div> : topicItems.map((item) => <article className="memory-item-card" key={item.id}><div className="memory-card-top"><span className={`memory-type-tag type-${item.item_type}`}>{item.item_type.replaceAll("_", " ")}</span><time>{formatTranscriptTime(item.start_seconds)}</time></div><h4>{item.title}</h4><p>{item.content}</p><blockquote>{item.evidence_quote}</blockquote></article>)}
              </div>}

              {activeTab === "decisions" && <div className="tab-content">
                <div className="content-heading"><div><h3>Decisions & follow-ups</h3></div><span className={`preview-tag ${decisionItems.length ? "ready-tag" : ""}`}>{decisionItems.length ? `${decisionItems.length} ITEMS` : "EMPTY"}</span></div>
                {decisionItems.length === 0 ? <div className="transcript-empty"><span className="empty-symbol">✓</span><strong>Nothing recorded yet</strong><p>Evidence-backed decisions, action items and open questions will appear here when the transcript has been processed.</p><button className="outline-button memory-inline-button" type="button" onClick={() => setActiveTab("memory")}>View meeting memory</button></div> : decisionItems.map((item) => <article className="memory-item-card" key={item.id}><div className="memory-card-top"><span className={`memory-type-tag type-${item.item_type}`}>{item.item_type.replaceAll("_", " ")}</span><time>{formatTranscriptTime(item.start_seconds)}</time></div><h4>{item.title}</h4><p>{item.content}</p><div className="memory-status-line">Status: {item.status}{item.decision_state ? ` · Decision state: ${item.decision_state}` : ""}{item.owner ? ` · Owner: ${item.owner}` : ""}</div><blockquote>{item.evidence_quote}</blockquote></article>)}
              </div>}

              {activeTab === "memory" && <div className="tab-content">
                <div className="content-heading memory-heading-row"><div><h3>Meeting memory</h3></div><span className={`preview-tag ${memoryConfigured ? "ready-tag" : ""}`}>{memoryConfigured === true ? "READY" : memoryConfigured === false ? "SETUP" : "CHECKING"}</span></div>
                {memoryConfigured === false && <div className="transcription-setup-notice"><strong>Memory extraction needs setup</strong><p>{memoryMessage || "Check the Groq API configuration and database migration status."} Keep the Groq key in the root <code>.env</code> file; never put it in frontend code.</p></div>}
                <div className="memory-toolbar"><span><strong>{selectedMemoryItems.length}</strong> saved item{selectedMemoryItems.length === 1 ? "" : "s"}</span><button className="outline-button" type="button" onClick={() => void extractSavedMemory()} disabled={!selectedMeetingId || !memoryConfigured || extractingMemory || transcriptSegments.length === 0}>{extractingMemory ? "Extracting…" : "Extract memory now"}</button></div>
                
                {memoryMessage && <p className="memory-feedback" role="status">{memoryMessage}</p>}
                {selectedMemoryItems.length === 0 && <div className="transcript-empty"><span className="empty-symbol">✳</span><strong>No memory items yet</strong><p>Memory appears after the meeting is processed.</p></div>}
                {selectedMemoryItems.map((item) => <article className="memory-item-card" key={item.id}><div className="memory-card-top"><span className={`memory-type-tag type-${item.item_type}`}>{item.item_type.replaceAll("_", " ")}</span><time>{formatTranscriptTime(item.start_seconds)}–{formatTranscriptTime(item.end_seconds)}</time></div><h4>{item.title}</h4><p>{item.content}</p>{(item.owner || item.decision_state) && <div className="memory-status-line">{item.decision_state ? `Decision state: ${item.decision_state}` : ""}{item.decision_state && item.owner ? " · " : ""}{item.owner ? `Owner: ${item.owner}` : ""}</div>}<blockquote>{item.evidence_quote}</blockquote><div className="memory-evidence-footer"><span>Status: {item.status}{item.decision_state ? ` · ${item.decision_state}` : ""}</span><span>{item.source_segment_ids.length} source segment{item.source_segment_ids.length === 1 ? "" : "s"}</span></div>{item.related_entities.length > 0 && <div className="memory-entity-list">{item.related_entities.map((entity) => <span key={entity}>{entity}</span>)}</div>}</article>)}
              </div>}
            </section>

            {selectedMeeting?.status === "active" && connection !== "connected" && (
              <div className="connection-feedback" role="status"><span className="feedback-dot" />{connectionMessage}</div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;
