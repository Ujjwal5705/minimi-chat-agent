import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus,
  Search,
  Globe2,
  MessageSquare,
  Clock3,
  Paperclip,
  Download,
  Trash2,
  Menu,
  X,
  CornerDownLeft,
  Square,
  ChevronDown,
  ExternalLink,
  Check,
  Copy,
  BookOpen,
  Sparkles,
} from "lucide-react";
import { readSSE } from "../shared/sse";
import type { Conversation, StreamEvent, Turn } from "../shared/types";
import "./styles.css";

type Config = { configured: boolean; model: string; timezone: string };
type Draft = { question: string; answer: string; status: string };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok)
    throw new Error((await response.json()).error || "Request failed.");
  return response.status === 204 ? (undefined as T) : response.json();
}

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? "logo-small" : ""}`} aria-hidden="true">
      m<span>ı</span>
    </span>
  );
}

function Answer({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const clean = text
    .replace(/【\d+†L[^】]*】/g, " [source reference]")
    .replace(/〖[^〗]*〗/g, " [source reference]")
    .replace(/cite[^]*/g, " [source reference]");
  return (
    <div className={`markdown ${streaming ? "streaming" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={/^https?:\/\//i.test(href ?? "") ? href : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span>[Image: {alt || "omitted"}]</span>,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {clean}
      </Markdown>
    </div>
  );
}

function TurnView({
  turn,
  openMemory,
}: {
  turn: Turn;
  openMemory: (conversationId: string, turnId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <article className="exchange" id={`turn-${turn.id}`}>
      <div className="question-row">
        <span className="speaker">YOU</span>
        <div className="question-content">
          <p>{turn.question}</p>
          <time dateTime={turn.createdAt}>
            {new Date(turn.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
      </div>
      <div className="answer-row">
        <Logo small />
        <div className="answer-content">
          {turn.imported && (
            <div className="imported-label">
              <BookOpen size={13} /> Imported history · original answer, not
              rechecked
            </div>
          )}
          {turn.answer ? (
            <Answer text={turn.answer} />
          ) : (
            <p className="interrupted">
              {turn.status === "failed"
                ? "This answer failed. Send the question again to retry."
                : "This answer was stopped. Send the question again to continue."}
            </p>
          )}
          {turn.trace?.warning && (
            <p className="source-warning">{turn.trace.warning}</p>
          )}
          {turn.sources.length > 0 && (
            <details className="source-details">
              <summary>
                <Globe2 size={14} /> {turn.sources.length}{" "}
                {turn.sources.length === 1 ? "source" : "sources"}{" "}
                <ChevronDown size={14} />
              </summary>
              <div className="source-grid">
                {turn.sources.map((source, index) => (
                  <a
                    className="source-card"
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="source-domain">
                      {index + 1} ·{" "}
                      {new URL(source.url).hostname.replace(/^www\./, "")}
                      <ExternalLink size={12} />
                    </span>
                    <strong>{source.title}</strong>
                    <span className="source-origin">
                      {source.origin === "provider"
                        ? "Provider source"
                        : "Link in answer"}
                    </span>
                  </a>
                ))}
              </div>
            </details>
          )}
          {turn.trace && (
            <details className="trace-details">
              <summary>
                <Clock3 size={13} />{" "}
                {turn.trace.search === "off"
                  ? "From saved history"
                  : turn.trace.executedSearches !== null &&
                      turn.trace.executedSearches > 0
                    ? "Web search used"
                    : turn.trace.search === "required"
                      ? "Web search requested"
                      : "Response details"}{" "}
                <span>· {(turn.trace.elapsedMs / 1000).toFixed(1)}s</span>
                <ChevronDown size={13} />
              </summary>
              <div className="trace-body">
                {turn.trace.dateRange && (
                  <p>
                    Earlier conversation:{" "}
                    <strong>{turn.trace.dateRange.localDate}</strong>.{" "}
                    {turn.trace.dateRange.assumption}
                  </p>
                )}
                {turn.trace.memory.length > 0 && (
                  <>
                    <p className="trace-label">
                      Saved exchanges supplied as context
                    </p>
                    {turn.trace.memory.map((memory) => (
                      <button
                        className="memory-link"
                        key={memory.id}
                        onClick={() =>
                          openMemory(memory.conversationId, memory.id)
                        }
                      >
                        <MessageSquare size={13} />
                        <span>{memory.question}</span>
                        <time>
                          {new Date(memory.createdAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </time>
                      </button>
                    ))}
                  </>
                )}
                {turn.trace.historyTruncated && (
                  <p>
                    History exceeded the context limit. Some records or text
                    were omitted.
                  </p>
                )}
                <p>
                  {turn.trace.model} ·{" "}
                  {turn.trace.usage
                    ? `${turn.trace.usage.promptTokens.toLocaleString()} input / ${turn.trace.usage.completionTokens.toLocaleString()} output tokens`
                    : "Token usage unavailable"}
                  {turn.trace.firstTokenMs !== null
                    ? ` · first text ${(turn.trace.firstTokenMs / 1000).toFixed(1)}s`
                    : ""}
                </p>
                {turn.trace.search !== "off" &&
                  turn.trace.executedSearches === null && (
                    <p>
                      Groq did not expose a search execution count. Links in the
                      answer are not independently verified by this app.
                    </p>
                  )}
              </div>
            </details>
          )}
          {turn.answer && (
            <button
              className="copy-button"
              aria-label="Copy answer"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(turn.answer);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const navigation = useRef(0);

  async function refreshList() {
    const list = await api<Conversation[]>("/api/conversations");
    setConversations(list);
    return list;
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<Config>("/api/config"),
      api<Conversation[]>("/api/conversations"),
    ])
      .then(([c, list]) => {
        if (cancelled) return;
        setConfig(c);
        setConversations(list);
        const saved = localStorage.getItem("minimi-conversation");
        if (saved && list.some((item) => item.id === saved))
          void openConversation(saved);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    if (selected) localStorage.setItem("minimi-conversation", selected);
    else localStorage.removeItem("minimi-conversation");
  }, [selected, config]);

  useEffect(() => {
    if (nearBottom)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [draft, turns]);

  useEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    }
  }, [input]);

  async function openConversation(id: string, turnId?: string) {
    if (abort.current) return;
    const version = ++navigation.current;
    setLoading(true);
    setMobileNav(false);
    setError(null);
    try {
      const data = await api<{ conversation: Conversation; turns: Turn[] }>(
        `/api/conversations/${id}`,
      );
      if (version !== navigation.current) return;
      setSelected(id);
      setTurns(data.turns);
      setDraft(null);
      setNearBottom(!turnId);
      if (turnId)
        setTimeout(
          () =>
            document
              .getElementById(`turn-${turnId}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" }),
          70,
        );
    } catch (e) {
      if (version === navigation.current) setError((e as Error).message);
    } finally {
      if (version === navigation.current) setLoading(false);
    }
  }

  function newChat() {
    if (abort.current) return;
    navigation.current++;
    setSelected(null);
    setTurns([]);
    setDraft(null);
    setError(null);
    setInput("");
    setLoading(false);
    setMobileNav(false);
    textarea.current?.focus();
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (!input.trim() || abort.current || !config?.configured || loading)
      return;
    const question = input.trim();
    setInput("");
    setError(null);
    setNearBottom(true);
    setDraft({ question, answer: "", status: "Getting started…" });
    const controller = new AbortController();
    abort.current = controller;
    let conversationId = selected;
    let completed = false;
    try {
      if (!conversationId) {
        const conversation = await api<Conversation>("/api/conversations", {
          method: "POST",
          body: "{}",
        });
        conversationId = conversation.id;
        setSelected(conversation.id);
      }
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          requestId: crypto.randomUUID(),
          question,
          timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone || config.timezone,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Could not start this answer.",
        );
      if (!response.body) throw new Error("No response stream.");
      for await (const data of readSSE(response.body)) {
        const event = JSON.parse(data) as StreamEvent;
        if (event.type === "status")
          setDraft((d) => d && { ...d, status: event.message });
        if (event.type === "delta")
          setDraft((d) => d && { ...d, answer: d.answer + event.text });
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") {
          setTurns((previous) => [
            ...previous.filter((t) => t.id !== event.turn.id),
            event.turn,
          ]);
          completed = true;
          setDraft(null);
        }
      }
      if (!completed)
        throw new Error(
          "The connection ended before the answer finished. Your saved history is safe.",
        );
    } catch (e) {
      setError(
        controller.signal.aborted ? "Answer stopped." : (e as Error).message,
      );
      setDraft(null);
      setInput(question);
      if (conversationId) {
        try {
          const saved = await api<{ turns: Turn[] }>(
            `/api/conversations/${conversationId}`,
          );
          setTurns(saved.turns);
        } catch {
          /* Keep already loaded history. */
        }
      }
    } finally {
      abort.current = null;
      try {
        await refreshList();
      } catch {
        /* A transient list refresh must not replace a completed answer. */
      }
      textarea.current?.focus();
    }
  }

  async function importHistory(file?: File) {
    if (!file || abort.current) return;
    setError(null);
    try {
      if (file.size > 2_000_000)
        throw new Error("Use a history JSON file under 2 MB.");
      const conversation = await api<Conversation>("/api/import", {
        method: "POST",
        body: await file.text(),
      });
      await refreshList();
      await openConversation(conversation.id);
    } catch (e) {
      setError((e as Error).message);
    }
    if (importInput.current) importInput.current.value = "";
  }

  async function removeConversation(conversation: Conversation) {
    if (
      abort.current ||
      !window.confirm(`Delete “${conversation.title}” and its saved history?`)
    )
      return;
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      if (selected === conversation.id) newChat();
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const current = conversations.find((c) => c.id === selected);
  const empty = turns.length === 0 && !draft;
  const examples = [
    {
      icon: Globe2,
      label: "Get a fresh perspective",
      question:
        "What changed in managed Postgres hosting this month? Compare pricing and notable releases from official sources.",
    },
    {
      icon: Clock3,
      label: "Pick up where you left off",
      question:
        "What did I ask you on 3 November? Is your answer still correct today?",
    },
    {
      icon: MessageSquare,
      label: "Follow the changes",
      question:
        "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    },
  ];

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation"
        />
      )}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <Logo />
          <span>
            minimi<span className="brand-dot">.</span>
          </span>
          <button
            className="mobile-close icon-button"
            onClick={() => setMobileNav(false)}
            aria-label="Close navigation"
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="new-chat"
          onClick={newChat}
          disabled={Boolean(draft)}
        >
          <Plus size={18} /> New conversation <span>⌘ K</span>
        </button>
        <label className="history-search">
          <Search size={16} />
          <input
            aria-label="Search conversations"
            placeholder="Find a conversation"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <div className="sidebar-label">
          YOUR CONVERSATIONS{" "}
          <span>{conversations.length.toString().padStart(2, "0")}</span>
        </div>
        <nav className="conversation-list" aria-label="Conversations">
          {conversations
            .filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()))
            .map((conversation) => (
              <div
                className={`conversation-item ${selected === conversation.id ? "selected" : ""}`}
                key={conversation.id}
              >
                <button
                  className="conversation-select"
                  disabled={Boolean(draft)}
                  onClick={() => void openConversation(conversation.id)}
                >
                  <MessageSquare size={15} />
                  <span>{conversation.title}</span>
                </button>
                <button
                  className="delete-chat"
                  aria-label={`Delete ${conversation.title}`}
                  disabled={Boolean(draft)}
                  onClick={() => void removeConversation(conversation)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          {conversations.length === 0 && (
            <p className="history-empty">
              A clean slate.
              <br />
              Your conversations will live here.
            </p>
          )}
          {conversations.length > 0 &&
            filter &&
            !conversations.some((c) =>
              c.title.toLowerCase().includes(filter.toLowerCase()),
            ) && <p className="history-empty">No conversations match.</p>}
        </nav>
        <div className="sidebar-footer">
          <div className="memory-note">
            <span className="note-icon">
              <BookOpen size={18} />
            </span>
            <div>
              <strong>A little memory goes a long way.</strong>
              <p>Pick up any conversation. Even in a new chat.</p>
            </div>
          </div>
          <div className="history-tools">
            <button
              onClick={() => importInput.current?.click()}
              disabled={Boolean(draft)}
            >
              <Paperclip size={14} /> Import history
            </button>
            {selected && turns.some((t) => t.status === "complete") && (
              <a href={`/api/conversations/${selected}/export`} download>
                <Download size={14} /> Export
              </a>
            )}
          </div>
          <div className="local-note">
            Saved on this device’s server <span>v1.0</span>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>{current?.title || "A little more clarity"}</span>
          </div>
          <div className="model-pill">
            <span
              className={`model-dot ${config?.configured ? "ready" : ""}`}
            />
            GPT-OSS {config?.model === "openai/gpt-oss-20b" ? "20B" : "120B"}
            <span className="model-via"> / Groq</span>
          </div>
        </header>
        <div
          className={`chat-scroll ${empty ? "welcome-scroll" : ""}`}
          ref={scroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            setNearBottom(
              el.scrollHeight - el.scrollTop - el.clientHeight < 150,
            );
          }}
        >
          {loading ? (
            <div className="loading-conversation" role="status">
              Opening your conversation…
            </div>
          ) : empty ? (
            <section className="welcome">
              <div className="eyebrow">
                <Sparkles size={15} /> CONTEXT MAKES THE DIFFERENCE
              </div>
              <h1>
                Keep the thread.
                <br />
                <span>Find what’s new.</span>
              </h1>
              <p className="welcome-description">
                A conversation that remembers where you left off,
                <br className="desktop-break" /> with fresh sources for what
                comes next.
              </p>
              <div className="welcome-capabilities">
                <span>
                  <Globe2 size={15} /> Live web search
                </span>
                <span>
                  <Clock3 size={15} /> Conversation memory
                </span>
                <span>
                  <BookOpen size={15} /> Sources you can follow
                </span>
              </div>
              <div className="suggestion-grid">
                {examples.map(({ icon: Icon, label, question }) => (
                  <button
                    className="suggestion"
                    key={label}
                    onClick={() => {
                      setInput(question);
                      textarea.current?.focus();
                    }}
                  >
                    <Icon size={19} />
                    <strong>{label}</strong>
                    <p>{question}</p>
                    <span>Try this conversation</span>
                  </button>
                ))}
              </div>
              <p className="history-hint">
                Starting fresh? Ask anything. Import earlier chats to try the
                memory examples.
              </p>
            </section>
          ) : (
            <div className="transcript">
              {turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  openMemory={(id, turnId) => void openConversation(id, turnId)}
                />
              ))}
              {draft && (
                <article className="exchange live-exchange">
                  <div className="question-row">
                    <span className="speaker">YOU</span>
                    <div className="question-content">
                      <p>{draft.question}</p>
                    </div>
                  </div>
                  <div className="answer-row">
                    <Logo small />
                    <div className="answer-content">
                      {draft.answer ? (
                        <Answer text={draft.answer} streaming />
                      ) : (
                        <div className="working" role="status">
                          <span className="working-dots">
                            <i />
                            <i />
                            <i />
                          </span>
                          {draft.status}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              )}
            </div>
          )}
        </div>
        <div className={`composer-wrap ${empty ? "composer-welcome" : ""}`}>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          {config && !config.configured && (
            <div className="setup-banner">
              <span className="setup-key">One small setup step</span> Add{" "}
              <code>GROQ_API_KEY</code> to <code>.env</code> and restart the
              server.{" "}
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                Get a key <ExternalLink size={11} />
              </a>
            </div>
          )}
          <form
            className={`composer ${draft ? "composer-busy" : ""}`}
            onSubmit={(e) => void send(e)}
          >
            <label className="sr-only" htmlFor="message">
              Message minimi
            </label>
            <textarea
              id="message"
              ref={textarea}
              placeholder="Ask a question, or pick up a thread…"
              value={input}
              maxLength={12_000}
              rows={1}
              disabled={loading}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bottom">
              <span>
                <Globe2 size={14} />{" "}
                {draft ? draft.status : "Web search, when it matters"}
              </span>
              {draft ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  aria-label="Stop answer"
                  onClick={() => abort.current?.abort()}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!input.trim() || !config?.configured || loading}
                  aria-label="Send message"
                >
                  <CornerDownLeft size={19} />
                </button>
              )}
            </div>
          </form>
          <p className="composer-note">
            <span>
              Thoughtful answers. Check the sources for decisions that matter.
            </span>
            <span className="keyboard-hint">
              Enter to send · Shift + Enter for a new line
            </span>
          </p>
        </div>
      </main>
      <input
        type="file"
        ref={importInput}
        accept="application/json,.json"
        className="sr-only"
        aria-label="Import conversation JSON"
        onChange={(e) => void importHistory(e.target.files?.[0])}
      />
      <KeyboardShortcut onNew={newChat} />
    </div>
  );
}

function KeyboardShortcut({ onNew }: { onNew: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNew]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
