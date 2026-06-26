"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, Mail, Plus, Save, Send, Slack, Trash2 } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

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
  const [profiles, setProfiles] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [configResponse, profilesResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/notification-profiles")
    ]);
    const configPayload = await configResponse.json();
    const profilesPayload = await profilesResponse.json();
    if (!configResponse.ok || !configPayload.ok) {
      setError(configPayload.error || "Could not load notification settings.");
      return;
    }
    if (!profilesResponse.ok || !profilesPayload.ok) {
      setError(profilesPayload.error || "Could not load notification profiles.");
      return;
    }
    setConfig(configPayload.config);
    setForm(configPayload.config.values || {});
    setProfiles(profilesPayload.profiles || []);
  }

  async function save(event) {
    event?.preventDefault?.();
    setMessage("");
    setError("");
    const [configResponse, profilesResponse] = await Promise.all([
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      }),
      fetch("/api/notification-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles })
      })
    ]);
    const configPayload = await configResponse.json();
    const profilesPayload = await profilesResponse.json();
    if (!configResponse.ok || !configPayload.ok) {
      setError(configPayload.error || "Could not save notification settings.");
      return;
    }
    if (!profilesResponse.ok || !profilesPayload.ok) {
      setError(profilesPayload.error || "Could not save notification profiles.");
      return;
    }
    setConfig(configPayload.config);
    setForm(configPayload.config.values || {});
    setProfiles(profilesPayload.profiles || []);
    setMessage("Notification profiles saved.");
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
    const slackCount = payload.slack?.profileCount ?? payload.slack?.results?.length ?? 0;
    const emailCount = payload.smtp?.profileCount ?? payload.smtp?.results?.length ?? 0;
    setMessage(`Digest processed. Slack profiles: ${slackCount}. Email profiles: ${emailCount}.`);
  }

  async function testBrowserNotification(profile) {
    setSending(`browser-${profile.profileId}`);
    setMessage("");
    setError("");
    const response = await fetch("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: profile.profileId })
    });
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
    setMessage(`${profile.displayName || "Profile"} preview: ${payload.digest.summary.total} matching item${payload.digest.summary.total === 1 ? "" : "s"}.`);
  }

  function addProfile() {
    const name = session?.actorName && !profiles.some((profile) => profile.displayName === session.actorName)
      ? session.actorName
      : `Reviewer ${profiles.length + 1}`;
    setProfiles((current) => [
      ...current,
      {
        profileId: crypto.randomUUID(),
        displayName: name,
        enabled: true,
        emailRecipients: "",
        slackWebhookUrl: "",
        rules: {
          channels: [],
          testTypes: [],
          statuses: ["confirmed_finished", "applied_change_observed", "past_due_check"]
        }
      }
    ]);
  }

  function updateProfile(profileId, patch) {
    setProfiles((current) =>
      current.map((profile) => (profile.profileId === profileId ? { ...profile, ...patch } : profile))
    );
  }

  function updateRules(profileId, key, value) {
    setProfiles((current) =>
      current.map((profile) =>
        profile.profileId === profileId
          ? { ...profile, rules: { ...(profile.rules || {}), [key]: value } }
          : profile
      )
    );
  }

  function removeProfile(profileId) {
    setProfiles((current) => current.filter((profile) => profile.profileId !== profileId));
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
            <h2>Team notification profiles</h2>
            <p className="muted">
              The detector queue is shared. Profiles decide who receives which channel, test type, and status.
              SMTP sender settings are shared; Slack webhooks and email recipients can be profile-specific.
            </p>
          </div>
          <div className="notification-actions">
            <button className="secondary-button" type="button" onClick={addProfile}>
              <Plus size={17} />
              Add Profile
            </button>
            <button className="primary-button" type="button" onClick={sendDigest} disabled={sending === "digest"}>
              <Send size={17} />
              {sending === "digest" ? "Sending..." : "Send Digest Now"}
            </button>
          </div>
        </section>

        <form onSubmit={save} className="notifications-grid">
          <section className="settings-panel notification-schedule">
            <p className="eyebrow">Shared Sender</p>
            <h2>Email delivery</h2>
            <p className="muted">
              These SMTP values send email for every profile. Each profile controls its own recipients and filters.
            </p>
            <SettingField label="Daily digest time" name="DAILY_DIGEST_TIME_LOCAL" value={form.DAILY_DIGEST_TIME_LOCAL || "09:00"} onChange={(value) => setForm((current) => ({ ...current, DAILY_DIGEST_TIME_LOCAL: value }))} />
            <SettingField label="SMTP host" name="SMTP_HOST" value={form.SMTP_HOST || ""} source={config?.sources?.SMTP_HOST} onChange={(value) => setForm((current) => ({ ...current, SMTP_HOST: value }))} />
            <SettingField label="SMTP port" name="SMTP_PORT" value={form.SMTP_PORT || "587"} source={config?.sources?.SMTP_PORT} onChange={(value) => setForm((current) => ({ ...current, SMTP_PORT: value }))} />
            <SettingField label="SMTP username" name="SMTP_USERNAME" value={form.SMTP_USERNAME || ""} source={config?.sources?.SMTP_USERNAME} onChange={(value) => setForm((current) => ({ ...current, SMTP_USERNAME: value }))} />
            <SettingField label="SMTP password" name="SMTP_PASSWORD" secret value={form.SMTP_PASSWORD || ""} source={config?.sources?.SMTP_PASSWORD} onChange={(value) => setForm((current) => ({ ...current, SMTP_PASSWORD: value }))} />
            <SettingField label="From email" name="SMTP_FROM" value={form.SMTP_FROM || ""} source={config?.sources?.SMTP_FROM} onChange={(value) => setForm((current) => ({ ...current, SMTP_FROM: value }))} />
          </section>

          <section className="settings-panel notification-schedule">
            <p className="eyebrow">Profile Defaults</p>
            <h2>Recommended routing</h2>
            <div className="notification-guidance">
              <span><Bell size={16} /> Start with confirmed finished, applied change observed, and past due check.</span>
              <span><Mail size={16} /> Use email recipients for people, Slack webhooks for channels or DMs.</span>
              <span><Slack size={16} /> Leave a filter empty when that profile should receive all values.</span>
            </div>
          </section>

          {profiles.length ? (
            profiles.map((profile) => (
              <ProfileCard
                key={profile.profileId}
                profile={profile}
                channels={channels}
                sending={sending}
                onChange={(patch) => updateProfile(profile.profileId, patch)}
                onRuleChange={(key, value) => updateRules(profile.profileId, key, value)}
                onRemove={() => removeProfile(profile.profileId)}
                onPreview={() => testBrowserNotification(profile)}
              />
            ))
          ) : (
            <section className="settings-panel notification-empty full-width">
              <h2>No notification profiles yet</h2>
              <p className="muted">Add one profile per teammate or workflow. Nothing profile-specific will send until a profile exists.</p>
              <button className="primary-button" type="button" onClick={addProfile}>
                <Plus size={17} />
                Add First Profile
              </button>
            </section>
          )}

          <section className="settings-panel full-width notification-save-panel">
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button">
              <Save size={17} />
              Save Notification Profiles
            </button>
          </section>
        </form>
      </main>
    </AppShell>
  );
}

function ProfileCard({ profile, channels, sending, onChange, onRuleChange, onRemove, onPreview }) {
  return (
    <section className={`settings-panel notification-profile-card ${profile.enabled ? "" : "disabled"}`}>
      <div className="profile-card-header">
        <div>
          <p className="eyebrow">Notification Profile</p>
          <h2>{profile.displayName || "Reviewer"}</h2>
        </div>
        <label className="profile-toggle">
          <input type="checkbox" checked={profile.enabled !== false} onChange={(event) => onChange({ enabled: event.target.checked })} />
          Enabled
        </label>
      </div>

      <div className="profile-fields">
        <SettingField label="Name or initials" name={`name-${profile.profileId}`} value={profile.displayName || ""} onChange={(value) => onChange({ displayName: value })} />
        <SettingField label="Email recipients" name={`email-${profile.profileId}`} value={profile.emailRecipients || ""} onChange={(value) => onChange({ emailRecipients: value })} />
        <SettingField label="Slack webhook URL" name={`slack-${profile.profileId}`} secret value={profile.slackWebhookUrl || ""} onChange={(value) => onChange({ slackWebhookUrl: value })} />
      </div>

      <RulePicker title="Channels" hint="Empty means every channel." options={channels.map((channel) => [channel, channel])} value={profile.rules?.channels || []} onChange={(value) => onRuleChange("channels", value)} />
      <RulePicker title="Test type" hint="Empty means title and thumbnail." options={TEST_TYPE_OPTIONS} value={profile.rules?.testTypes || []} onChange={(value) => onRuleChange("testTypes", value)} />
      <RulePicker title="Statuses" hint="Choose what should notify this profile." options={STATUS_OPTIONS} value={profile.rules?.statuses || []} onChange={(value) => onRuleChange("statuses", value)} />

      <div className="profile-actions">
        <button className="secondary-button" type="button" onClick={onPreview} disabled={sending === `browser-${profile.profileId}`}>
          <Bell size={16} />
          {sending === `browser-${profile.profileId}` ? "Testing..." : "Preview Browser Count"}
        </button>
        <button className="secondary-button danger-button" type="button" onClick={onRemove}>
          <Trash2 size={16} />
          Remove
        </button>
      </div>
    </section>
  );
}

function RulePicker({ title, hint, options, value, onChange }) {
  const selected = new Set(Array.isArray(value) ? value : parseList(value));
  function toggle(option) {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(Array.from(next));
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

function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
