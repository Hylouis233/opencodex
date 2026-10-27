/**
 * Process-local opt-in for incremental Codex WebSocket uploads. Default off.
 * Lives in the config layer so config loading never pulls the Responses transport into a
 * Child or Hub client's load graph; the transport subscribes to drop retained state on disable.
 */
let incrementalUpload = false;
const disableListeners = new Set<() => void>();

export function setCodexWsIncrementalUpload(enabled: boolean): void {
  incrementalUpload = enabled;
  if (!enabled) for (const listener of disableListeners) listener();
}

export function codexWsIncrementalUploadEnabled(): boolean {
  return incrementalUpload;
}

export function onCodexWsIncrementalUploadDisabled(listener: () => void): void {
  disableListeners.add(listener);
}
