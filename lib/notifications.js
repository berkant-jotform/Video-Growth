import { listQueue, summarizeQueue } from "@/lib/repository.js";
import { getAppConfig } from "@/lib/config.js";
import { filterQueue } from "@/lib/notification-rules.mjs";
import { listNotificationProfiles } from "@/lib/notification-profiles.js";
import nodemailer from "nodemailer";

export async function buildDigest(method = "all", ruleOverride = null, profile = null) {
  const config = await getAppConfig();
  const rule = ruleOverride || config.notificationRules?.[method] || {};
  const queue = await listQueue();
  const filteredQueue = filterQueue(queue, rule);
  const summary = summarizeQueue(filteredQueue);
  const top = filteredQueue.slice(0, 12);
  const lines = [
    "YouTube A/B Tests digest",
    "",
    profile?.displayName ? `Profile: ${profile.displayName}` : "",
    method !== "all" ? `Method: ${labelStatus(method)}` : "",
    ruleText(rule),
    "",
    `Confirmed finished: ${summary.confirmedFinished}`,
    `Applied change observed: ${summary.appliedChangeObserved}`,
    `Past due check: ${summary.pastDueCheck}`,
    `Needs signal: ${summary.uncovered}`,
    `Watching: ${summary.watching}`,
    `Missing data: ${summary.missingData}`,
    `Sheet changed after done: ${summary.sheetChangedAfterDone}`,
    `Possible retests: ${summary.possibleRetest}`,
    "",
    ...top.map((run) => {
      const outcome = run.suggestedWinner || labelStatus(run.queueStatus || run.status);
      return `- ${run.channel} | ${run.testType} | ${outcome} | ${run.videoTitle || run.videoId}`;
    })
  ];
  return {
    summary,
    subject: `YouTube A/B Tests: ${summary.total} items need attention`,
    text: lines.filter((line, index, all) => line || all[index - 1]).join("\n"),
    top
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
      text: fallbackDigest.text
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
      text: digest.text
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
