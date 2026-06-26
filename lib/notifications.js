import { listQueue, summarizeQueue } from "@/lib/repository.js";
import { getAppConfig } from "@/lib/config.js";
import { emailSubject, filterQueue } from "@/lib/notification-rules.mjs";
import { listNotificationProfiles } from "@/lib/notification-profiles.js";
import nodemailer from "nodemailer";

export async function buildDigest(method = "all", ruleOverride = null, profile = null) {
  const config = await getAppConfig();
  const rule = ruleOverride || config.notificationRules?.[method] || {};
  const queue = await listQueue();
  const filteredQueue = filterQueue(queue, rule);
  const summary = summarizeQueue(filteredQueue);
  const sections = digestSections(filteredQueue);
  const subject = emailSubject(summary, profile);
  const lines = compactLines([
    "YouTube A/B Tests digest",
    profile?.displayName ? `Profile: ${profile.displayName}` : "",
    "",
    `Needs action: ${summary.confirmedFinished + summary.appliedChangeObserved}`,
    `Manual checks: ${summary.pastDueCheck}`,
    `Possible retests: ${summary.possibleRetest}`,
    "",
    profile?.displayName ? `Profile: ${profile.displayName}` : "",
    method !== "all" ? `Method: ${labelStatus(method)}` : "",
    ruleText(rule),
    "",
    ...textSection("Confirmed finished", sections.confirmed, 8),
    ...textSection("Applied change observed", sections.observed, 6),
    ...textSection("Needs manual check", sections.pastDue, 4),
    sections.pastDue.length > 4 ? `+ ${sections.pastDue.length - 4} more manual checks in the dashboard` : ""
  ]);
  return {
    summary,
    subject,
    text: lines.join("\n"),
    html: buildDigestHtml({ summary, sections, profile, rule }),
    top: [...sections.confirmed, ...sections.observed, ...sections.pastDue].slice(0, 12)
  };
}

export async function sendSlackDigest() {
  const config = await getAppConfig();
  const profiles = await listNotificationProfiles();
  const targets = profiles.filter((profile) => profile.enabled && profile.slackWebhookUrl);
  if (!targets.length) {
    const digest = await buildDigest("slack");
    if (!config.slackWebhookUrl) return { ok: true, skipped: true, channel: "slack", profiles: [], digest };
    const response = await sendSlack(config.slackWebhookUrl, digest.text);
    return { ok: response.ok, channel: "slack", status: response.status, profiles: [], digest };
  }

  const results = [];
  for (const profile of targets) {
    const digest = await buildDigest("slack", profile.rules, profile);
    const response = await sendSlack(profile.slackWebhookUrl, digest.text);
    results.push({
      ok: response.ok,
      status: response.status,
      profileId: profile.profileId,
      displayName: profile.displayName,
      matched: digest.summary.total,
      digest
    });
  }
  return {
    ok: results.every((item) => item.ok),
    channel: "slack",
    profileCount: targets.length,
    results
  };
}

export async function sendEmailDigest() {
  const config = await getAppConfig();
  const profiles = await listNotificationProfiles();
  const targets = profiles.filter((profile) => profile.enabled && profile.emailRecipients);
  const configured = Boolean(
    config.smtpHost &&
      config.smtpUsername &&
      config.smtpPassword &&
      (config.digestEmailRecipients || targets.length)
  );
  const fallbackDigest = await buildDigest("email");
  if (!configured) {
    return {
      ok: true,
      skipped: true,
      channel: "smtp",
      configured: false,
      recipients: config.digestEmailRecipients,
      profiles: targets.length,
      digest: fallbackDigest
    };
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort || 587),
    secure: Number(config.smtpPort || 587) === 465,
    auth: {
      user: config.smtpUsername,
      pass: config.smtpPassword
    }
  });

  if (!targets.length) {
    const info = await transporter.sendMail({
      from: config.smtpFrom || config.smtpUsername,
      to: config.digestEmailRecipients,
      subject: fallbackDigest.subject,
      text: fallbackDigest.text,
      html: fallbackDigest.html
    });
    return {
      ok: true,
      channel: "smtp",
      configured: true,
      recipients: config.digestEmailRecipients,
      profiles: [],
      messageId: info.messageId,
      digest: fallbackDigest
    };
  }

  const results = [];
  for (const profile of targets) {
    const digest = await buildDigest("email", profile.rules, profile);
    const info = await transporter.sendMail({
      from: config.smtpFrom || config.smtpUsername,
      to: profile.emailRecipients,
      subject: digest.subject,
      text: digest.text,
      html: digest.html
    });
    results.push({
      ok: true,
      profileId: profile.profileId,
      displayName: profile.displayName,
      recipients: profile.emailRecipients,
      matched: digest.summary.total,
      messageId: info.messageId,
      digest
    });
  }

  return {
    ok: true,
    channel: "smtp",
    configured: true,
    profileCount: targets.length,
    results
  };
}

async function sendSlack(webhookUrl, text) {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}

function ruleText(rule = {}) {
  const parts = [];
  if (rule.channels?.length) parts.push(`channels: ${rule.channels.join(", ")}`);
  if (rule.testTypes?.length) parts.push(`types: ${rule.testTypes.join(", ")}`);
  if (rule.statuses?.length) parts.push(`statuses: ${rule.statuses.join(", ")}`);
  return parts.length ? `Filters: ${parts.join(" | ")}` : "Filters: all shared queue items";
}

function labelStatus(status) {
  return String(status || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function digestSections(queue) {
  return {
    confirmed: queue.filter((run) => run.queueStatus === "confirmed_finished"),
    observed: queue.filter((run) => run.queueStatus === "applied_change_observed"),
    pastDue: queue.filter((run) => run.queueStatus === "past_due_check"),
    other: queue.filter((run) => !["confirmed_finished", "applied_change_observed", "past_due_check"].includes(run.queueStatus))
  };
}

function textSection(title, runs, limit) {
  if (!runs.length) return [];
  return [
    `${title}:`,
    ...runs.slice(0, limit).map((run) => {
      const name = run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video";
      return `- ${run.channel || "Unknown channel"} | ${labelStatus(run.testType)} | ${digestRunStatus(run)} | ${name}${run.studioUrl ? ` | ${run.studioUrl}` : ""}`;
    }),
    ""
  ];
}

function buildDigestHtml({ summary, sections, profile, rule }) {
  const actionCount = summary.confirmedFinished + summary.appliedChangeObserved;
  const dashboardUrl = appBaseUrl();
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f6f8;color:#162026;font-family:Inter,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:28px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:680px;max-width:calc(100vw - 28px);background:#ffffff;border:1px solid #dfe6ec;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:24px 26px;background:#10161b;color:#f7fafc;">
                <div style="color:#ff4b5f;font-size:12px;font-weight:800;text-transform:uppercase;">YouTube A/B Tests</div>
                <h1 style="margin:6px 0 0;font-size:28px;line-height:1.1;">${escapeHtml(profile?.displayName ? `${profile.displayName} digest` : "Test finish digest")}</h1>
                <p style="margin:10px 0 0;color:#aeb8c2;font-size:14px;">${escapeHtml(ruleText(rule))}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 26px;">
                ${metricGrid([
                  ["Ready", actionCount],
                  ["Confirmed", summary.confirmedFinished],
                  ["Observed", summary.appliedChangeObserved],
                  ["Manual checks", summary.pastDueCheck]
                ])}
                ${dashboardUrl ? `<p style="margin:0 0 18px;"><a href="${escapeAttribute(dashboardUrl)}" style="display:inline-block;background:#10161b;color:#ffffff;text-decoration:none;border-radius:8px;padding:11px 14px;font-size:13px;font-weight:850;">Open dashboard</a></p>` : ""}
                ${htmlSection("Ready to check in Studio", sections.confirmed, "These have a real finish signal.", 8, "#d92d3f")}
                ${htmlSection("Applied change observed", sections.observed, "YouTube metadata changed; verify in Studio.", 6, "#1d6fd6")}
                ${htmlSection("Needs manual check", sections.pastDue, "Secondary queue. These are not confirmed finished; sample shown only.", 4, "#b7791f")}
                ${sections.pastDue.length > 4 ? `<div style="margin:14px 0 0;padding:12px 14px;border:1px solid #dfe6ec;border-radius:10px;background:#f8fafb;color:#53616d;font-size:13px;line-height:1.45;"><strong style="color:#162026;">${sections.pastDue.length - 4} more manual checks</strong><br>Use the dashboard filters for the full list instead of reviewing all manual checks from email.</div>` : ""}
                ${!actionCount && !summary.pastDueCheck ? `<p style="margin:18px 0;color:#697783;font-size:15px;">No urgent finished tests matched this profile.</p>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function metricGrid(items) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;">
    <tr>
      ${items.map(([label, value]) => `<td style="width:25%;padding:0 8px 0 0;">
        <div style="border:1px solid #dfe6ec;border-radius:10px;padding:12px;background:#f8fafb;">
          <div style="color:#6d7a86;font-size:11px;font-weight:800;text-transform:uppercase;">${escapeHtml(label)}</div>
          <div style="font-size:24px;font-weight:850;margin-top:4px;">${Number(value || 0)}</div>
        </div>
      </td>`).join("")}
    </tr>
  </table>`;
}

function htmlSection(title, runs, note, limit, accent) {
  if (!runs.length) return "";
  return `<div style="margin-top:22px;">
    <h2 style="margin:0;font-size:18px;line-height:1.2;">${escapeHtml(title)}</h2>
    <p style="margin:5px 0 12px;color:#697783;font-size:13px;">${escapeHtml(note)}</p>
    ${runs.slice(0, limit).map((run) => htmlRunCard(run, accent)).join("")}
  </div>`;
}

function htmlRunCard(run, accent) {
  const name = run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video";
  const status = digestRunStatus(run);
  const studio = run.studioUrl
    ? `<a href="${escapeAttribute(run.studioUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:800;">Open Studio</a>`
    : "";
  return `<div style="border:1px solid #dfe6ec;border-left:4px solid ${accent};border-radius:10px;padding:13px 14px;margin:10px 0;background:#ffffff;">
    <div style="color:#6d7a86;font-size:11px;font-weight:850;text-transform:uppercase;">${escapeHtml(run.channel || "Unknown channel")} · ${escapeHtml(labelStatus(run.testType))} · ${escapeHtml(status)}</div>
    <div style="font-size:15px;font-weight:820;line-height:1.3;margin:5px 0 10px;">${escapeHtml(name)}</div>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        <td style="width:1%;white-space:nowrap;padding:0 10px 0 0;">${studio}</td>
        <td style="color:#7b8792;font-size:12px;line-height:1.3;vertical-align:middle;">${escapeHtml(run.videoId || "")}</td>
      </tr>
    </table>
  </div>`;
}

function digestRunStatus(run) {
  if (run.queueStatus === "confirmed_finished") return run.suggestedWinner ? `Winner ${run.suggestedWinner}` : "Confirmed finished";
  if (run.queueStatus === "applied_change_observed") return "Applied change observed";
  if (run.queueStatus === "past_due_check") return "Needs manual check";
  return labelStatus(run.queueStatus || run.status);
}

function compactLines(lines) {
  return lines.filter((line, index, all) => line || all[index - 1]);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function appBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "";
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  return vercelUrl ? `https://${vercelUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "";
}
