"use client";

import { ArrowUp, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BrandMark } from "./brand-mark";
import { GraphView, type StateGraph } from "./graph-view";

type GraphFrame = {
  frame: Record<string, unknown>;
  graph: StateGraph;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type StreamEvent = {
  type: "activity" | "graph" | "final" | "error";
  phase?: string;
  step?: number;
  output?: string;
  frame?: GraphFrame;
  graph?: StateGraph;
  message?: string;
  metadata?: { durationMs?: number; stepCount?: number; retryCount?: number };
};

type SavedSession = {
  messages: Message[];
  frame?: GraphFrame;
};

const SESSION_KEY = "stateweave-ai-session-v1";
const emptyGraph: StateGraph = { nodes: [], edges: [] };
const suggestions = [
  "A decision I am making",
  "A project already in motion",
  "Something I want remembered",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [frame, setFrame] = useState<GraphFrame>();
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState("Ready");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as SavedSession | null;
        if (saved?.messages && Array.isArray(saved.messages)) setMessages(saved.messages.slice(-80));
        if (saved?.frame?.graph) setFrame(saved.frame);
      } catch {
        localStorage.removeItem(SESSION_KEY);
      } finally {
        setReady(true);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = prompt.trim();
    if (!input || sending) return;

    const previousFrame = frame;
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: input };
    setMessages((current) => [...current, userMessage]);
    setPrompt("");
    setError("");
    setSending(true);
    setActivity("Opening the graph");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, frame }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? "StateWeave is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalEvent: StreamEvent | undefined;

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const streamEvent = JSON.parse(line) as StreamEvent;
          if (streamEvent.type === "graph" && streamEvent.frame && streamEvent.graph) {
            setFrame(streamEvent.frame);
            setActivity(streamEvent.phase === "before" ? "Reading the whole picture" : "Graph updated");
          } else if (streamEvent.type === "activity") {
            setActivity(activityLabel(streamEvent.phase, streamEvent.step));
          } else if (streamEvent.type === "error") {
            throw new Error(streamEvent.message ?? "StateWeave could not complete this turn.");
          } else if (streamEvent.type === "final") {
            finalEvent = streamEvent;
          }
        }
        if (done) break;
      }

      if (!finalEvent?.output || !finalEvent.frame) throw new Error("StateWeave finished without an answer.");
      const assistantMessage: Message = { id: crypto.randomUUID(), role: "assistant", content: finalEvent.output };
      const nextMessages = [...messages, userMessage, assistantMessage].slice(-80);
      setMessages(nextMessages);
      setFrame(finalEvent.frame);
      setActivity(finalEvent.metadata?.stepCount ? `Woven in ${finalEvent.metadata.stepCount} step${finalEvent.metadata.stepCount === 1 ? "" : "s"}` : "Graph updated");
      localStorage.setItem(SESSION_KEY, JSON.stringify({ messages: nextMessages, frame: finalEvent.frame } satisfies SavedSession));
    } catch (caught) {
      setFrame(previousFrame);
      setActivity("Graph unchanged");
      setError(caught instanceof Error ? caught.message : "StateWeave could not complete this turn.");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function startNewThread() {
    if (sending || (!messages.length && !frame)) return;
    setMessages([]);
    setFrame(undefined);
    setPrompt("");
    setError("");
    setActivity("Ready");
    localStorage.removeItem(SESSION_KEY);
    inputRef.current?.focus();
  }

  function chooseSuggestion(value: string) {
    setPrompt(value);
    inputRef.current?.focus();
  }

  const graph = frame?.graph ?? emptyGraph;
  const hasConversation = messages.length > 0;

  return (
    <main className={`shell ${hasConversation ? "is-chatting" : "is-empty"}`}>
      {!hasConversation ? <HeroWeave /> : null}

      <nav className="nav" aria-label="Primary navigation">
        <Link className="wordmark" href="/" aria-label="StateWeave home">
          <BrandMark className="mark" />
          <span>StateWeave</span>
        </Link>
        <div className="nav-actions">
          {hasConversation ? (
            <button className="new-thread" type="button" onClick={startNewThread} disabled={sending}>
              <Trash size={15} /> New thread
            </button>
          ) : null}
          <a className="primitive-link" href="https://stateweave.dev">For builders <span aria-hidden="true">↗</span></a>
        </div>
      </nav>

      <section className={`agent-stage ${hasConversation ? "has-conversation" : ""} ${ready ? "is-ready" : ""}`}>
        <div className="conversation-panel">
          {!hasConversation ? (
            <header className="intro">
              <h1>What should<br />not be lost?</h1>
              <p>Bring the decision, project, or context. StateWeave keeps the connections alive.</p>
            </header>
          ) : (
            <div className="messages" aria-live="polite">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-body">
                    <header className="message-meta">
                      <i className="turn-marker" aria-hidden="true" />
                      <span>{message.role === "user" ? "You" : "StateWeave"}</span>
                    </header>
                    <MessageContent content={message.content} markdown={message.role === "assistant"} />
                  </div>
                </article>
              ))}
              {sending ? (
                <article className="message assistant pending">
                  <div className="message-body">
                    <header className="message-meta">
                      <i className="turn-marker" aria-hidden="true" />
                      <span>StateWeave</span>
                    </header>
                    <div className="pending-state" role="status">
                      <span>{activity}</span>
                      <div className="weave-loader" aria-hidden="true"><i /><i /><i /></div>
                    </div>
                  </div>
                </article>
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="prompt-area">
            <form className="composer" onSubmit={submit}>
              <label htmlFor="prompt">{hasConversation ? "Continue the thread." : "Begin anywhere."}</label>
              <div className="input-row">
                <span className="composer-thread" aria-hidden="true" />
                <textarea
                  id="prompt"
                  ref={inputRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  maxLength={4_000}
                  placeholder={hasConversation ? "Add what matters next" : "Tell us what matters"}
                  disabled={sending}
                />
                <button className="send" type="submit" aria-label="Send prompt" disabled={sending || !prompt.trim()}>
                  <ArrowUp size={18} weight="bold" />
                </button>
              </div>
            </form>

            {!hasConversation ? (
              <div className="suggestions" aria-label="Prompt suggestions">
                {suggestions.map((item) => <button key={item} type="button" onClick={() => chooseSuggestion(item)}>{item}</button>)}
              </div>
            ) : null}
            {error ? <p className="error-message" role="alert">{error}</p> : null}
          </div>
        </div>

        <aside className="memory-panel" aria-label="Live StateWeave graph">
          <header className="memory-header">
            <div>
              <p>Living memory</p>
              <span>{activity}</span>
            </div>
            <dl>
              <div><dt>Nodes</dt><dd>{graph.nodes.length}</dd></div>
              <div><dt>Edges</dt><dd>{graph.edges.length}</dd></div>
            </dl>
          </header>
          <GraphView graph={graph} active={sending} />
          <footer className="memory-footer">
            <span>StateGraph</span>
            <span>GraphFrame → GraphOps → StateGraph</span>
          </footer>
        </aside>
      </section>
    </main>
  );
}

function HeroWeave() {
  return (
    <div className="hero-weave" aria-hidden="true">
      <div className="hero-warps"><i /><i /><i /><i /><i /><i /><i /></div>
      <div className="hero-weft hero-weft-top"><i /><i /><i /></div>
      <div className="hero-weft hero-weft-bottom"><i /><i /><i /></div>
      <span className="hero-state-stitch" />
    </div>
  );
}

function MessageContent({ content, markdown }: { content: string; markdown: boolean }) {
  if (markdown) {
    return (
      <div className="message-content markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  const blocks = content.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="message-content">
      {blocks.map((block, index) => <p key={`${index}:${block.slice(0, 24)}`}>{block}</p>)}
    </div>
  );
}

function activityLabel(phase?: string, step?: number): string {
  const suffix = step ? ` · step ${step}` : "";
  if (phase === "weaving" || phase === "ops") return `Weaving new connections${suffix}`;
  if (phase === "retrying") return `Refining the graph${suffix}`;
  if (phase === "queued" || phase === "started") return `Exploring a branch${suffix}`;
  if (phase === "thinking") return `Thinking with the graph${suffix}`;
  return `Working${suffix}`;
}
