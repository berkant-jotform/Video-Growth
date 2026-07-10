export async function runFinishCheckWorkflow({ checkSignals, refreshQueue, onStage = () => {} }) {
  onStage({ running: true, extension: "running", refresh: "pending", message: "Checking Studio finish signals..." });
  let extensionResult;
  try {
    extensionResult = await checkSignals();
  } catch (error) {
    extensionResult = { ok: false, error: error?.message || "Studio signal check failed." };
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
