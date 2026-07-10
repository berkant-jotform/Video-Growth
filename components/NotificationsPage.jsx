"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, ChevronDown, Mail, Plus, Save, Send, Settings2, Trash2, Users } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const STATUS_OPTIONS = [
  ["confirmed_finished", "Confirmed finished"],
  ["applied_change_observed", "Applied change observed"],
  ["past_due_check", "Needs manual check"],
  ["uncovered", "Needs signal"],
  ["watching", "Watching"],
  ["missing_data", "Missing data"]
];

const TEST_TYPE_OPTIONS = [
  ["title", "Title"],
  ["thumbnail", "Thumbnail"]
];

const DEFAULT_CHANNELS = ["Jotform", "AI Agents Podcast", "AI Agents", "Apps", "Sign"];

export default function NotificationsPage({ session }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({});
  const [profiles, setProfiles] = useState([]);
  const [savedForm, setSavedForm] = useState({});
  const [savedProfiles, setSavedProfiles] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError("");
    try {
      const [configResponse, profilesResponse] = await Promise.all([
        fetch("/api/config", { cache: "no-store" }),
        fetch("/api/notification-profiles", { cache: "no-store" })
      ]);
      const configPayload = await configResponse.json().catch(() => ({}));
      const profilesPayload = await profilesResponse.json().catch(() => ({}));
      if (!configResponse.ok || !configPayload.ok) throw new Error(configPayload.error || "Could not load notification settings.");
      if (!profilesResponse.ok || !profilesPayload.ok) throw new Error(profilesPayload.error || "Could not load notification profiles.");
      setConfig(configPayload.config);
      setForm(configPayload.config.values || {});
      setProfiles(profilesPayload.profiles || []);
      setSavedForm(configPayload.config.values || {});
      setSavedProfiles(profilesPayload.profiles || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load notification settings.");
    } finally {
      setLoading(false);
    }
  }

  async function save(event) {
    event?.preventDefault?.();
    setMessage("");
    setError("");
    setSaving(true);
    try {
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
      const configPayload = await configResponse.json().catch(() => ({}));
      const profilesPayload = await profilesResponse.json().catch(() => ({}));
      if (!configResponse.ok || !configPayload.ok) throw new Error(configPayload.error || "Could not save notification settings.");
      if (!profilesResponse.ok || !profilesPayload.ok) throw new Error(profilesPayload.error || "Could not save notification profiles.");
      setConfig(configPayload.config);
      setForm(configPayload.config.values || {});
      setProfiles(profilesPayload.profiles || []);
      setSavedForm(configPayload.config.values || {});
      setSavedProfiles(profilesPayload.profiles || []);
      setMessage("Notification profiles saved.");
    } catch (saveError) {
      setError(saveError.message || "Could not save notification profiles.");
    } finally {
      setSaving(false);
    }
  }

  async function sendDigest() {
    setSending("digest");
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/notifications/digest", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not send digest.");
      const slackCount = payload.slack?.profileCount ?? payload.slack?.results?.length ?? 0;
      const emailCount = payload.smtp?.profileCount ?? payload.smtp?.results?.length ?? 0;
      setMessage(`Digest processed. Slack profiles: ${slackCount}. Email profiles: ${emailCount}.`);
    } catch (sendError) {
      setError(sendError.message || "Could not send digest.");
    } finally {
      setSending("");
    }
  }

  async function testBrowserNotification(profile) {
    setSending(`browser-${profile.profileId}`);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: profile.profileId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not create browser notification preview.");
      if (!("Notification" in window)) throw new Error("This browser does not support desktop notifications.");
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Browser notification permission was not granted.");
      }
      new Notification(payload.browserNotification.title, { body: payload.browserNotification.body });
      setMessage(`${profile.displayName || "Profile"} preview: ${payload.digest.summary.total} matching item${payload.digest.summary.total === 1 ? "" : "s"}.`);
    } catch (previewError) {
      setError(previewError.message || "Could not create browser notification preview.");
    } finally {
      setSending("");
    }
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
          statuses: ["confirmed_finished", "applied_change_observed"]
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
  const hasChanges = useMemo(
    () => stableJson(form) !== stableJson(savedForm) || stableJson(profiles) !== stableJson(savedProfiles),
    [form, profiles, savedForm, savedProfiles]
  );
  const activeProfiles = profiles.filter((profile) => profile.enabled !== false).length;
  const emailReady = Boolean(form.SMTP_HOST && form.SMTP_USERNAME && form.SMTP_PASSWORD && form.SMTP_FROM);

  useEffect(() => {
    const warn = (event) => {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasChanges]);

  return (
    <AppShell session={session} active="notifications">
      <main className="workspace notifications-workspace">
        <section className="page-intro notification-hero">
          <div>
            <p className="eyebrow">Notifications</p>
            <h2>Team notification profiles</h2>
            <p className="muted">
              Create one profile per teammate or workflow. Each profile chooses its own channels, test types, outcomes, and destinations.
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
          <div className="notification-summary-strip">
            <span><Users size={17} /><strong>{activeProfiles}</strong> active profiles</span>
            <span><Mail size={17} /><strong>{emailReady ? "Ready" : "Setup needed"}</strong> email sender</span>
            <span><Bell size={17} /><strong>{form.DAILY_DIGEST_TIME_LOCAL || "09:00"}</strong> daily digest</span>
          </div>
        </section>

        <form onSubmit={save} className="notifications-grid">
          {loading ? (
            <section className="settings-panel notification-empty full-width">
              <h2>Loading notification profiles...</h2>
            </section>
          ) : profiles.length ? (
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

          <details className="settings-panel full-width notification-shared-settings">
            <summary>
              <span className="panel-icon"><Settings2 size={19} /></span>
              <span><strong>Shared email sender</strong><em>{emailReady ? "Configured" : "Setup needed"}</em></span>
              <ChevronDown size={18} />
            </summary>
            <div className="notification-shared-settings-body">
              <p className="muted">Configure this once for the whole team. Individual recipients remain inside each profile.</p>
              <div className="profile-fields">
                <SettingField label="Daily digest time" name="DAILY_DIGEST_TIME_LOCAL" value={form.DAILY_DIGEST_TIME_LOCAL || "09:00"} onChange={(value) => setForm((current) => ({ ...current, DAILY_DIGEST_TIME_LOCAL: value }))} />
                <SettingField label="SMTP host" name="SMTP_HOST" value={form.SMTP_HOST || ""} source={config?.sources?.SMTP_HOST} onChange={(value) => setForm((current) => ({ ...current, SMTP_HOST: value }))} />
                <SettingField label="SMTP port" name="SMTP_PORT" value={form.SMTP_PORT || "587"} source={config?.sources?.SMTP_PORT} onChange={(value) => setForm((current) => ({ ...current, SMTP_PORT: value }))} />
                <SettingField label="SMTP username" name="SMTP_USERNAME" value={form.SMTP_USERNAME || ""} source={config?.sources?.SMTP_USERNAME} onChange={(value) => setForm((current) => ({ ...current, SMTP_USERNAME: value }))} />
                <SettingField label="SMTP password" name="SMTP_PASSWORD" secret value={form.SMTP_PASSWORD || ""} source={config?.sources?.SMTP_PASSWORD} onChange={(value) => setForm((current) => ({ ...current, SMTP_PASSWORD: value }))} />
                <SettingField label="From email" name="SMTP_FROM" value={form.SMTP_FROM || ""} source={config?.sources?.SMTP_FROM} onChange={(value) => setForm((current) => ({ ...current, SMTP_FROM: value }))} />
              </div>
            </div>
          </details>

          <section className={`settings-panel full-width notification-save-panel ${hasChanges ? "has-changes" : ""}`}>
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <span className="notification-save-state">{hasChanges ? "Unsaved notification changes" : "All notification settings saved"}</span>
            <button className="primary-button" disabled={saving || loading}>
              <Save size={17} />
              {saving ? "Saving..." : "Save Changes"}
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
