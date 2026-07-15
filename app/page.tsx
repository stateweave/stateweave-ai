"use client";

import { ArrowUp, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { FormEvent, useRef, useState } from "react";

const prompts = [
  "Help me think this through",
  "Organize what I know",
  "Keep track of this project",
];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function selectPrompt(value: string) {
    setPrompt(value);
    setNotice("");
    inputRef.current?.focus();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) {
      inputRef.current?.focus();
      return;
    }
    setNotice("Your thought is ready. The StateWeave agent connection comes next.");
  }

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <Link className="wordmark" href="/" aria-label="StateWeave home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          StateWeave
        </Link>
        <a className="primitive-link" href="https://stateweave.dev">
          For builders <span aria-hidden="true">↗</span>
        </a>
      </nav>

      <section className="experience" aria-labelledby="hero-title">
        <div className="field" aria-hidden="true">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <span className="orbit orbit-three" />
          <span className="core" />
        </div>

        <div className="intro">
          <p className="eyebrow">A mind with continuity</p>
          <h1 id="hero-title">Keep the<br />whole picture.</h1>
          <p className="subhead">Start anywhere. Think, plan, and build with an agent that remembers what matters.</p>
        </div>

        <div className="prompt-area">
          <form className="composer" onSubmit={submit}>
            <label htmlFor="prompt">What are you working through?</label>
            <div className="input-row">
              <button className="attach" type="button" aria-label="Add context">
                <Plus size={18} weight="regular" />
              </button>
              <textarea
                id="prompt"
                ref={inputRef}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setNotice("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={1}
                placeholder="Ask StateWeave"
              />
              <button className="send" type="submit" aria-label="Send prompt">
                <ArrowUp size={18} weight="bold" />
              </button>
            </div>
          </form>

          <div className="suggestions" aria-label="Prompt suggestions">
            {prompts.map((item) => (
              <button key={item} type="button" onClick={() => selectPrompt(item)}>{item}</button>
            ))}
          </div>
          <p className={`notice ${notice ? "visible" : ""}`} role="status" aria-live="polite">
            {notice || "Prototype ready"}
          </p>
        </div>
      </section>

      <footer>
        <span>StateWeave</span>
        <span>Memory for agents, shaped around you.</span>
      </footer>
    </main>
  );
}
