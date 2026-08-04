import { stoppedCheckOperation } from "./scan-cancellation.mjs";

export async function runFinishCheckWorkflow({ checkSignals, refreshQueue, onStage = () => {}, shouldStop = () => false }) {
  onStage({ running: true, extension: "running", refresh: "pending", message: "Checking Studio finish signals..." });
  let extensionResult;
  try {
    extensionResult = await checkSignals();
  } catch (error) {
    extensionResult = { ok: false, error: error?.message || "Studio signal check failed." };
  }
  if (shouldStop()) {
    const operation = stoppedCheckOperation({
      extension: extensionResult?.ok ? "ok" : "warn",
      message: "Check stopped before the queue refresh began. Previous results were preserved."
    });
    onStage(operation);
    return { extensionResult, refreshResult: { ok: false, cancelled: true }, operation };
  }
  onStage({
    running: true,
    extension: extensionResult?.ok ? "ok" : "warn",
    refresh: "running",
    message: extensionResult?.ok
      ? "Studio signals checked. Updating the selected queue..."
      : "Studio signals were unavailable. Updating Sheets and YouTube anyway..."
  });

  let refreshResult;
  try {
    refreshResult = await refreshQueue();
  } catch (error) {
    refreshResult = { ok: false, error: error?.message || "Queue refresh failed." };
  }
  if (refreshResult?.cancelled) {
    const operation = stoppedCheckOperation({
      extension: extensionResult?.ok ? "ok" : "warn"
    });
    onStage(operation);
    return { extensionResult, refreshResult, operation };
  }
  const result = {
    running: false,
    extension: extensionResult?.ok ? "ok" : "warn",
    refresh: refreshResult?.ok ? "ok" : "error",
    message: refreshResult?.ok
      ? extensionResult?.ok
        ? "Finish signals checked and queue updated."
        : "Queue updated. The extension check could not run, so Studio-only finishes may be missing."
      : "The queue refresh failed. Previous results are still available below."
  };
  onStage(result);
  return { extensionResult, refreshResult, operation: result };
}
