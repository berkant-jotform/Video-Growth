function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * Formats a calendar date without applying a timezone conversion.
 * PostgreSQL DATE values arrive as local-midnight Date objects; converting
 * those through UTC can move the calendar day and split one test identity.
 */
export function formatDateOnly(value) {
  if (!value) return "";

  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
