"use client";

import { useState } from "react";
import { LockKeyhole } from "lucide-react";

export default function LoginForm() {
  const [actorName, setActorName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        <div className="login-icon">
          <LockKeyhole size={22} />
        </div>
        <p className="eyebrow">YouTube A/B Tests</p>
        <h1>Open the detector</h1>
        <label>
          Your name or initials
          <input value={actorName} onChange={(event) => setActorName(event.target.value)} />
        </label>
        <label>
          Shared password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" disabled={busy}>
          {busy ? "Checking" : "Enter"}
        </button>
      </form>
    </main>
  );
}
