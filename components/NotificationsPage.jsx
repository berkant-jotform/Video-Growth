"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, Mail, Save, Send, Slack } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const METHODS = [
  {
    key: "slack",
    title: "Slack Digest",
    icon: Slack,
    description: "Send filtered queue digests to one shared Slack webhook.",
    fields: [["SLACK_WEBHOOK_URL", "Slack webhook URL", "input", true]],
    prefix: "NOTIFICATION_SLACK"
  },
  {
    key: "email",
    title: "Email Digest",
    icon: Mail,
    description: "Send filtered queue digests to the shared recipient list.",
    fields: [
      ["SMTP_HOST", "SMTP host", "input"],
      ["SMTP_PORT", "SMTP port", "input"],
      ["SMTP_USERNAME", "SMTP username", "input"],
      ["SMTP_PASSWORD", "SMTP password", "input", true],
      ["SMTP_FROM", "From email", "input"],
      ["DIGEST_EMAIL_RECIPIENTS", "Digest recipients", "input"]
    ],
    prefix: "NOTIFICATION_EMAIL"
  },
  {
    key: "browser",
    title: "Browser Notification Preview",
    icon: Bell,
    description: "Control what the in-browser notification preview counts.",
    fields: [],
    prefix: "NOTIFICATION_BROWSER"
  }
];

const STATUS_OPTIONS = [
  ["confirmed_finished", "Confirmed finished"],
  ["applied_change_observed", "Applied change observed"],
  ["past_due_check", "Past due check"],
  ["uncovered", "Needs signal"],
  ["watching", "Watching"],
  ["missing_data", "Missing data"],
  ["sheet_changed_after_done", "Sheet changed after done"]
];

const TEST_TYPE_OPTIONS = [
  ["title", "Title"],
  ["thumbnail", "Thumbnail"]
];

const DEFAULT_CHANNELS = ["Jotform", "AI Agents Podcast", "AI Agents", "Jotform Apps", "Jotform Sign"];

export default function NotificationsPage({ session }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const response = await fetch("/api/config");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not load notification settings.");
      return;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
  }

  async function save(event) {
    event?.preventDefault?.();
    setMessage("");
    setError("");
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not save notification settings.");
      return;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
    setMessage("Notification settings saved.");
  }

  async function sendDigest() {
    setSending("digest");
    setMessage("");
    setError("");
    const response = await fetch("/api/notifications/digest", { method: "POST" });
    const payload = await response.json();
    setSending("");
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not send digest.");
      return;
    }
    const slack = payload.slack?.skipped ? "Slack skipped" : `Slack ${payload.slack?.ok ? "sent" : "failed"}`;
    const email = payload.smtp?.skipped ? "Email skipped" : `Email ${payload.smtp?.ok ? "sent" : "failed"}`;
    setMessage(`${slack}. ${email}.`);
  }

  async function testBrowserNotification() {
    setSending("browser");
    setMessage("");
    setError("");
    const response = await fetch("/api/notifications/test", { method: "POST" });
    const payload = await response.json();
    setSending("");
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not create browser notification preview.");
      return;
    }
    if ("Notification" in window) {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission === "granted") {
        new Notification(payload.browserNotification.title, { body: payload.browserNotification.body });
      }
    }
    setMessage(`Browser preview ready: ${payload.digest.summary.total} matching item${payload.digest.summary.total === 1 ? "" : "s"}.`);
  }

  const channels = useMemo(() => {
    const configured = parseList(form.CONNECTOR_CHANNELS);
    return Array.from(new Set([...configured, ...DEFAULT_CHANNELS])).filter(Boolean);
  }, [form.CONNECTOR_CHANNELS]);

  return (
    <AppShell session={session} active="notifications">
      <main className="workspace notifications-workspace">
        <section className="settings-panel full-width notification-hero">
          <div>
            <p className="eyebrow">Notifications</p>
            <h2>Shared team digest rules</h2>
            <p className="muted">
              These settings are app-wide. If you add your email or Slack webhook, the whole team uses that same
              routing until we add real per-user accounts.
            </p>
          </div>
          <div className="notification-actions">
            <button className="secondary-button" type="button" onClick={testBrowserNotification} disabled={sending === "browser"}>
              <Bell size={17} />
              {sending === "browser" ? "Testing..." : "Test Browser Preview"}
            </button>
            <button className="primary-button" type="button" onClick={sendDigest} disabled={sending === "digest"}>
              <Send size={17} />
              {sending === "digest" ? "Sending..." : "Send Slack + Email Digest"}
            </button>
          </div>
        </section>

        <form onSubmit={save} className="notifications-grid">
          <section className="settings-panel notification-schedule">
            <p className="eyebrow">Schedule</p>
            <h2>Digest timing</h2>
            <SettingField
              label="Daily digest time"
              name="DAILY_DIGEST_TIME_LOCAL"
              value={form.DAILY_DIGEST_TIME_LOCAL || "09:00"}
              onChange={(value) => setForm((current) => ({ ...current, DAILY_DIGEST_TIME_LOCAL: value }))}
            />
            <p className="field-hint">
              Scheduled delivery depends on Vercel Cron. Manual send works from this page.
            </p>
          </section>

          {METHODS.map((method) => (
            <MethodCard
              key={method.key}
              method={method}
              channels={channels}
              form={form}
              config={config}
              onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
            />
          ))}

          <section className="settings-panel full-width notification-save-panel">
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button">
              <Save size={17} />
              Save Notification Settings
            </button>
          </section>
        </form>
      </main>
    </AppShell>
  );
}

function MethodCard({ method, channels, form, config, onChange }) {
  const Icon = method.icon;
  const channelKey = `${method.prefix}_CHANNELS`;
  const typeKey = `${method.prefix}_TEST_TYPES`;
  const statusKey = `${method.prefix}_STATUSES`;
  return (
    <section className="settings-panel notification-method-card">
      <div className="notification-method-title">
        <span className={`notification-method-icon ${method.key}`}>
          <Icon size={18} />
        </span>
        <div>
          <p className="eyebrow">{method.title}</p>
          <h2>{method.key === "slack" ? connectionLabel(config?.configured?.slack) : method.key === "email" ? connectionLabel(config?.configured?.smtp && config?.configured?.digestEmail) : "Local browser"}</h2>
        </div>
      </div>
      <p className="muted">{method.description}</p>

      {method.fields.length ? (
        <div className="notification-fields">
          {method.fields.map(([key, label, type, secret]) => (
            <SettingField
              key={key}
              label={label}
              name={key}
              type={type}
              secret={Boolean(secret)}
              source={config?.sources?.[key]}
              value={form[key] || ""}
              onChange={(value) => onChange(key, value)}
            />
          ))}
        </div>
      ) : null}

      <RulePicker
        title="Channels"
        hint="Leave empty to include all channels."
        options={channels.map((channel) => [channel, channel])}
        value={form[channelKey] || ""}
        onChange={(value) => onChange(channelKey, value)}
      />
      <RulePicker
        title="Test type"
        hint="Leave empty to include title and thumbnail tests."
        options={TEST_TYPE_OPTIONS}
        value={form[typeKey] || ""}
        onChange={(value) => onChange(typeKey, value)}
      />
      <RulePicker
        title="Statuses"
        hint="Recommended: confirmed finished, applied change observed, and past due check."
        options={STATUS_OPTIONS}
        value={form[statusKey] || ""}
        onChange={(value) => onChange(statusKey, value)}
      />
    </section>
  );
}

function RulePicker({ title, hint, options, value, onChange }) {
  const selected = new Set(parseList(value));
  function toggle(option) {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(Array.from(next).join(", "));
  }
  return (
    <div className="rule-picker">
      <div>
        <strong>{title}</strong>
        <span>{selected.size ? `${selected.size} selected` : "All"}</span>
      </div>
      <div className="rule-options">
        {options.map(([valueOption, label]) => (
          <button
            type="button"
            className={selected.has(valueOption) ? "rule-option active" : "rule-option"}
            key={valueOption}
            onClick={() => toggle(valueOption)}
          >
            {label}
          </button>
        ))}
      </div>
      <p>{hint}</p>
    </div>
  );
}

function SettingField({ label, name, type = "input", value, source, secret, onChange }) {
  const [cleared, setCleared] = useState(false);
  const visibleValue = cleared && secret ? "" : value;
  const sharedProps = {
    id: name,
    value: visibleValue,
    placeholder: secret && value === "********" ? "Saved secret" : "",
    onChange: (event) => {
      setCleared(false);
      onChange(event.target.value);
    }
  };
  return (
    <label className="setting-field">
      <span>
        {label}
        {source ? <em>{source === "app" ? "Saved in app" : source}</em> : null}
      </span>
      {type === "textarea" ? <textarea rows={4} {...sharedProps} /> : <input type={secret ? "password" : "text"} {...sharedProps} />}
      {secret && value === "********" ? (
        <button
          className="secondary-button remove-secret-button"
          type="button"
          onClick={() => {
            setCleared(true);
            onChange("__DELETE_SECRET__");
          }}
        >
          Remove saved value
        </button>
      ) : null}
    </label>
  );
}

function connectionLabel(ready) {
  return ready ? "Configured" : "Not configured";
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
