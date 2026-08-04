export class ScanCancelledError extends Error {
  constructor(message = "Scan stopped by reviewer.") {
    super(message);
    this.name = "ScanCancelledError";
    this.code = "SCAN_CANCELLED";
    this.cancelled = true;
  }
}

export function isScanCancelledError(error) {
  return Boolean(error?.cancelled || error?.code === "SCAN_CANCELLED" || error?.name === "ScanCancelledError");
}

export function stoppedCheckOperation({ extension = "warn", message = "Check stopped safely. The existing queue remains available." } = {}) {
  return {
    running: false,
    stopped: true,
    extension,
    refresh: "stopped",
    message
  };
}
