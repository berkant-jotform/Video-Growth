import { listQueue, summarizeQueue } from "@/lib/repository.js";
import { getAppConfig } from "@/lib/config.js";
import { filterQueue } from "@/lib/notification-rules.mjs";
import nodemailer from "nodemailer";

export async function buildDigest(method = "all") {
  const config = await getAppConfig();
  const rule = config.notificationRules?.[method] || {};
  const queue = await listQueue();
  const filteredQueue = filterQueue(queue, rule);
  const summary = summarizeQueue(filteredQueue);
  const top = filteredQueue.slice(0, 12);
  const lines = [
    "YouTube A/B Tests digest",
    "",
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
  const digest = await buildDigest("slack");
  if (!config.slackWebhookUrl) return { ok: true, skipped: true, channel: "slack", digest };
  const response = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: digest.text })
  });
  return {
    ok: response.ok,
    channel: "slack",
    status: response.status,
    digest
  };
}

export async function sendEmailDigest() {
  const config = await getAppConfig();
  const digest = await buildDigest("email");
  const configured = Boolean(
    config.smtpHost &&
      config.smtpUsername &&
      config.smtpPassword &&
      config.digestEmailRecipients
  );
  if (!configured) {
    return {
      ok: true,
      skipped: true,
      channel: "smtp",
      configured: false,
      recipients: config.digestEmailRecipients,
      digest
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
  const info = await transporter.sendMail({
    from: config.smtpFrom || config.smtpUsername,
    to: config.digestEmailRecipients,
    subject: digest.subject,
    text: digest.text
  });
  return {
    ok: true,
    channel: "smtp",
    configured: true,
    recipients: config.digestEmailRecipients,
    messageId: info.messageId,
    digest
  };
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
