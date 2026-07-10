const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out.")), timeoutMs);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      const timeoutError = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      timeoutError.name = "TimeoutError";
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export async function readJsonResponse(response, fallbackMessage = "Request failed.") {
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `${fallbackMessage} HTTP ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
