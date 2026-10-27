/**
 * Process-local opt-in for incremental Codex WebSocket uploads. Default off.
 * Lives in the config layer so config loading never pulls the Responses transport into a
 * Child or Hub client's load graph; the transport subscribes to drop retained state on disable.
 */
import type { OcxConfig } from "../types";
import { setCodexWsReuseAcrossTurns } from "./codex-ws-reuse-setting";

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

/**
 * Bind the opt-in to the adopted live server config only, so detached `loadConfig()` reads
 * (CLI, management snapshots) never enable incremental sends or clear retained state.
 * Incremental upload implies cross-turn reuse, matching the load-time reuse derivation.
 */
export function bindCodexWsIncrementalConfig(config: Pick<OcxConfig, "codexWsIncrementalUpload" | "codexWsReuseAcrossTurns">): void {
  const enabled = config.codexWsIncrementalUpload === true;
  setCodexWsIncrementalUpload(enabled);
  setCodexWsReuseAcrossTurns(config.codexWsReuseAcrossTurns === true || enabled);
}
