"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

export default function LoginForm() {
  const [actorName, setActorName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRequired, setPasswordRequired] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((payload) => {
        setPasswordRequired(Boolean(payload?.configured?.sharedPassword));
      })
      .catch(() => {
        setPasswordRequired(true);
      });
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/access/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorName, password })
    });
    const payload = await response.json();
    setBusy(false);
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Login failed.");
      return;
    }
    window.location.href = "/";
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <Image
          className="login-logo"
          src="/icon-192.png"
          alt="YouTube A/B Tests"
          width={72}
          height={72}
          priority
        />
        <p className="eyebrow">YouTube A/B Tests</p>
        <h1>Open the detector</h1>
        <label>
          Your name or initials
          <input value={actorName} onChange={(event) => setActorName(event.target.value)} />
        </label>
        {passwordRequired ? (
          <label>
            Shared password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        ) : (
          <p className="muted">Password is disabled. Enter your initials to continue.</p>
        )}
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" disabled={busy}>
          {busy ? "Checking" : "Enter"}
        </button>
      </form>
    </main>
  );
}
