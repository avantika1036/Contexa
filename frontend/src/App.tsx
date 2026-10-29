import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./App.css";

type TabId = "transcript" | "catchup" | "topic" | "decisions";
type ConnectionStatus = "connecting" | "connected" | "disconnected";

type ServerMessage = {
  type?: string;
  meeting_id?: string;
  message?: string;
  message_type?: string;
  byte_length?: number;
  transcription_status?: string;
};

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

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("transcript");
  const [connection, setConnection] =
    useState<ConnectionStatus>("connecting");
  const [connectionMessage, setConnectionMessage] = useState(
    "Connecting to Contexa API...",
  );
  const [question, setQuestion] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname || "127.0.0.1";

    const socket = new WebSocket(
      `${protocol}://${host}:8000/ws/meeting/demo-meeting`,
    );

    socketRef.current = socket;

    socket.onopen = () => {
      setConnection("connected");
      setConnectionMessage("Connected to the meeting service.");
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerMessage;

      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        setConnectionMessage("Received an unrecognized server message.");
        return;
      }

      switch (message.type) {
        case "connection.established":
          setConnectionMessage(
            `Connected to meeting ${message.meeting_id ?? "session"}.`,
          );
          break;

        case "pong":
          setConnectionMessage("Connection test successful.");
          break;

        case "message.received":
          setConnectionMessage(
            "Message delivered. AI answers are not implemented yet.",
          );
          break;

        case "audio.chunk.received":
          setConnectionMessage(
            "Audio chunk received; transcription is not implemented yet.",
          );
          break;

        case "error":
          setConnectionMessage(
            message.message ?? "The server rejected the message.",
          );
          break;

        default:
          setConnectionMessage(
            "Received a response from the meeting service.",
          );
      }
    };

    socket.onerror = () => {
      setConnectionMessage("Could not connect. Check that FastAPI is running.");
    };

    socket.onclose = () => {
      setConnection("disconnected");
      socketRef.current = null;
      setConnectionMessage("Disconnected from the meeting service.");
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);

  function sendMessage(payload: object): boolean {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnectionMessage("Not connected. Start the FastAPI backend.");
      return false;
    }

    socket.send(JSON.stringify(payload));
    return true;
  }

  function testConnection() {
    sendMessage({ type: "ping" });
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = question.trim();

    if (!text) return;

    if (
      sendMessage({
        type: "question",
        text,
      })
    ) {
      setQuestion("");
      setConnectionMessage(
        "Question sent to the backend. Grounded answers are coming in a later phase.",
      );
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Contexa home">
          <span className="brand-mark">C</span>
          <span>contexa</span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>

        <button className="nav-item active" type="button">
          <span className="nav-icon">▦</span>
          Meetings
        </button>

        <button className="nav-item" type="button" disabled>
          <span className="nav-icon">◷</span>
          Meeting history
          <span className="coming-soon">Later</span>
        </button>

        <div className="sidebar-bottom">
          <div className="privacy-note">
            <span className="privacy-icon">◇</span>
            <div>
              <strong>Privacy matters</strong>
              <p>Audio and recording controls will be added with capture.</p>
            </div>
          </div>

          <div className="profile">
            <div className="profile-avatar">A</div>
            <div>
              <strong>Local workspace</strong>
              <p>Development environment</p>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-area" id="home">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> Meetings <span>/</span>
            <strong>Live session</strong>
          </div>

          <div className="topbar-right">
            <span className={`connection-pill ${connection}`}>
              <span className="status-dot" />
              {connection === "connected"
                ? "Service connected"
                : connection === "connecting"
                  ? "Connecting"
                  : "Offline"}
            </span>
            <span className="environment-tag">LOCAL DEV</span>
          </div>
        </header>

        <div className="workspace">
          <section className="meeting-column">
            <div className="meeting-heading">
              <div>
                <div className="eyebrow">MEETING WORKSPACE</div>
                <h1>Replica Strategy Review</h1>
                <p className="meeting-subtitle">
                  Demo session <span>·</span> Illustrative participant layout
                </p>
              </div>

              <button
                className="outline-button"
                type="button"
                onClick={testConnection}
                disabled={connection !== "connected"}
              >
                <span>↗</span> Test connection
              </button>
            </div>

            <div className="meeting-stage">
              <div className="stage-top">
                <span className="stage-live">
                  <span className="status-dot" />
                  Preview mode
                </span>
                <span className="participant-count">
                  {participants.length} participants
                </span>
              </div>

              <div className="participant-grid">
                {participants.map((participant, index) => (
                  <div
                    className={`participant-card ${participant.style}`}
                    key={participant.initials}
                  >
                    <div className={`participant-avatar ${participant.style}`}>
                      {participant.initials}
                    </div>

                    <div className="participant-info">
                      <strong>{participant.name}</strong>
                      <span>{participant.role}</span>
                    </div>

                    <span className="participant-number">0{index + 1}</span>
                  </div>
                ))}
              </div>

              <div className="stage-footer">
                <span>Participant video is not connected yet.</span>
                <span>Microphone capture is the next milestone.</span>
              </div>
            </div>

            <div className="meeting-note">
              <div className="note-icon">i</div>
              <div>
                <strong>Context stays with the discussion</strong>
                <p>
                  Contexa is designed to help participants recover missed
                  context without manually searching meeting transcripts.
                </p>
              </div>
            </div>

            <div className="meeting-actions">
              <span className="action-label">SESSION CONTROLS</span>
              <div className="action-buttons">
                <button type="button" disabled title="Coming with audio capture">
                  ◖ <span>Microphone</span>
                </button>
                <button type="button" disabled title="Coming with video support">
                  ▣ <span>Camera</span>
                </button>
                <span className="controls-note">
                  Capture controls not enabled
                </span>
              </div>
            </div>
          </section>

          <aside className="copilot-panel">
            <div className="copilot-heading">
              <div className="copilot-avatar">C</div>
              <div className="copilot-title">
                <h2>Meeting Copilot</h2>
                <p>Live meeting context</p>
              </div>
              <span className={`mini-status ${connection}`}>
                {connection === "connected" ? "Connected" : "Offline"}
              </span>
            </div>

            <div className="copilot-intro">
              <div className="intro-sparkle">✳</div>
              <div>
                <strong>Stay in context.</strong>
                <p>
                  Explore discussion context, recover missed information, and
                  follow decisions.
                </p>
              </div>
            </div>

            <div className="copilot-tabs" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls="copilot-content"
                  className={activeTab === tab.id ? "selected" : ""}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <section
              className="copilot-content"
              id="copilot-content"
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              {activeTab === "transcript" && (
                <div className="tab-content">
                  <div className="content-heading">
                    <div>
                      <h3>Live transcript</h3>
                      <p>Preview · Not connected to speech recognition</p>
                    </div>
                    <span className="preview-tag">DEMO</span>
                  </div>

                  <div className="transcript-empty">
                    <span className="empty-symbol">≋</span>
                    <strong>Your transcript will appear here</strong>
                    <p>
                      Once microphone capture and streaming speech-to-text are
                      connected, timestamped discussion segments will appear
                      in this panel.
                    </p>
                  </div>

                  <div className="sample-block">
                    <div className="sample-label">ILLUSTRATIVE EXAMPLE</div>
                    <div className="sample-line">
                      <span className="sample-time">10:20</span>
                      <div>
                        <strong>Rahul</strong>
                        <p>
                          We should compare the replica options before deciding
                          on the read strategy.
                        </p>
                      </div>
                    </div>
                    <div className="sample-line">
                      <span className="sample-time">10:22</span>
                      <div>
                        <strong>Sarah</strong>
                        <p>
                          Let's benchmark both approaches before we make a
                          decision.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "catchup" && (
                <div className="tab-content">
                  <div className="content-heading">
                    <div>
                      <h3>Catch me up</h3>
                      <p>Recover a missed part of the discussion</p>
                    </div>
                    <span className="preview-tag">DEMO</span>
                  </div>

                  <div className="feature-card blue-card">
                    <span className="feature-label">DISCUSSION SUMMARY</span>
                    <h4>Replica strategy review</h4>
                    <p>
                      The team is comparing Redis and PostgreSQL read replicas
                      to decide how to handle read capacity.
                    </p>
                  </div>

                  <h4 className="section-title">During the discussion</h4>
                  <ul className="context-list">
                    <li>Redis was proposed to reduce database load.</li>
                    <li>Cache invalidation concerns were raised.</li>
                    <li>Read replicas were discussed as an alternative.</li>
                  </ul>

                  <div className="unresolved-card">
                    <strong>Still unresolved</strong>
                    <p>
                      Which approach should be selected after benchmarking?
                    </p>
                  </div>
                  <p className="sample-disclaimer">
                    Illustrative content only. Actual summaries will be
                    generated from meeting evidence in a later phase.
                  </p>
                </div>
              )}

              {activeTab === "topic" && (
                <div className="tab-content">
                  <div className="content-heading">
                    <div>
                      <h3>Current topic</h3>
                      <p>What the conversation is about</p>
                    </div>
                    <span className="preview-tag">DEMO</span>
                  </div>

                  <div className="feature-card blue-card">
                    <span className="feature-label">TOPIC</span>
                    <h4>Database read capacity</h4>
                    <p>
                      Evaluating alternatives for distributing read traffic
                      while considering performance and consistency.
                    </p>
                  </div>

                  <h4 className="section-title">Points being considered</h4>
                  <div className="topic-row">
                    <span className="topic-marker" />
                    <div>
                      <strong>Redis</strong>
                      <p>Potential reduction in database load.</p>
                    </div>
                  </div>
                  <div className="topic-row">
                    <span className="topic-marker purple-marker" />
                    <div>
                      <strong>PostgreSQL read replicas</strong>
                      <p>Alternative for distributing read workloads.</p>
                    </div>
                  </div>
                  <p className="sample-disclaimer">
                    Illustrative topic. Live topic detection is not implemented
                    yet.
                  </p>
                </div>
              )}

              {activeTab === "decisions" && (
                <div className="tab-content">
                  <div className="content-heading">
                    <div>
                      <h3>Key decisions</h3>
                      <p>Agreements and open questions</p>
                    </div>
                    <span className="preview-tag">DEMO</span>
                  </div>

                  <div className="decision-card">
                    <span className="decision-icon agreed">✓</span>
                    <div>
                      <strong>Benchmark both approaches</strong>
                      <p>Illustrative agreed action · 10:24</p>
                    </div>
                  </div>

                  <div className="decision-card">
                    <span className="decision-icon open">?</span>
                    <div>
                      <strong>Choose the final read strategy</strong>
                      <p>Open question · 10:26</p>
                    </div>
                  </div>

                  <p className="sample-disclaimer">
                    These are demo examples, not decisions retrieved from a
                    real meeting.
                  </p>
                </div>
              )}
            </section>

            <div className="connection-feedback" role="status">
              <span className="feedback-dot" />
              {connectionMessage}
            </div>

            <form className="question-form" onSubmit={submitQuestion}>
              <label htmlFor="question-input">Ask about the meeting</label>
              <div className="question-input-row">
                <input
                  id="question-input"
                  type="text"
                  placeholder="e.g. What options were discussed?"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  maxLength={1000}
                />
                <button
                  type="submit"
                  disabled={
                    connection !== "connected" || question.trim().length === 0
                  }
                  aria-label="Send question"
                  title="Send question to backend"
                >
                  →
                </button>
              </div>
              <p className="question-disclaimer">
                Currently tests message delivery only; AI answers are not
                available yet.
              </p>
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;