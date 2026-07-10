import { compareChannels } from "./channels.mjs";

const REVIEW_STATUSES = new Set(["action_conflict", "confirmed_finished"]);

export function buildReviewQueue(runs = [], { channel = "all", testType = "all", skippedIds = [] } = {}) {
  const skipped = new Set(skippedIds);
  return runs
    .filter((run) => REVIEW_STATUSES.has(run.queueStatus))
    .filter((run) => channel === "all" || run.channel === channel || run.youtubeChannelTitle === channel)
    .filter((run) => testType === "all" || run.testType === testType)
    .filter((run) => !skipped.has(run.testRunId))
    .sort((left, right) => {
      const statusDifference = statusRank(left.queueStatus) - statusRank(right.queueStatus);
      if (statusDifference) return statusDifference;
      const channelDifference = compareChannels(left.channel, right.channel);
      if (channelDifference) return channelDifference;
      if (left.testType !== right.testType) return left.testType === "thumbnail" ? -1 : 1;
      return signalTime(right) - signalTime(left);
    });
}

function statusRank(value) {
  return value === "action_conflict" ? 0 : 1;
}

function signalTime(run) {
  const value = run.finishEventOccurredAt || run.finishEventAt || run.effectiveFinishDate || run.finishDate || run.startDate;
  const parsed = value ? new Date(value).valueOf() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
