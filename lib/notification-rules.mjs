export function filterQueue(queue, rule = {}) {
  const channels = normalizeSet(rule.channels);
  const testTypes = normalizeSet(rule.testTypes);
  const statuses = normalizeSet(rule.statuses);
  return queue.filter((run) => {
    if (channels.size && !channels.has(normalize(run.channel))) return false;
    if (testTypes.size && !testTypes.has(normalize(run.testType))) return false;
    if (statuses.size && !statuses.has(normalize(run.queueStatus || run.status))) return false;
    return true;
  });
}

function normalizeSet(items = []) {
  return new Set((items || []).map(normalize).filter(Boolean));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
