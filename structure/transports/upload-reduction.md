# Optional Codex Upload Reduction

## Incremental WebSocket continuation

`src/server/responses/codex-ws-incremental.ts` owns the default-off
`codexWsIncrementalUpload` switch and bounded, socket-local completed-prefix state.
It implies cross-turn reuse. Ordinary canonical ChatGPT creates can send only newly
appended input and the acknowledged response ID when the envelope and full prefix match.
Provider-issued item IDs/status and empty reasoning content are normalized only for
comparison; ciphertext, call IDs, nonempty content and tool arguments remain exact.
Existing stateful lanes, native controls and warmup frames retain their own ownership.
Unknown, failed or incomplete completions cannot seed a future delta.

The opt-in preserves an explicit HTTP provider proxy instead of dropping it on the WS
path; unsupported egress and custom executors retain HTTP fallback. A per-request ID
travels in message metadata instead of fragmenting socket identity. Socket/account,
credential, thread, proxy and rewritten-destination boundaries remain authoritative.
Idle retention is at most three minutes, total age twenty minutes and exchanges 256;
comparison state is capped at 64 MiB per context and 128 MiB across contexts. Disabling
the feature clears comparison state. A cold oversized create uses existing HTTP/SSE;
the WS frame limit applies to the actual delta frame, not its omitted full reference.

`src/server/management/system-routes.ts` exposes content-free send/reference byte counters.
They compare WS JSON frames with full JSON, not compressed HTTP or interface billing.
`tests/responses/codex-ws-incremental.test.ts` covers prefix changes, identity separation,
unknown completion, ciphertext changes, references and image-policy composition.

## Historical image and tool context

`src/server/responses/history-slim.ts` applies optional `upstreamHistorySlim: "codex"`
only to canonical native Codex outbound HTTP string bodies, before compression, and to
ordinary upstream WS creates when incremental upload is enabled. It leaves local replay
state unchanged. Before the latest user message, oversized inline images become text
placeholders and oversized tool text keeps bounded head/tail excerpts. Current-turn
items, remote URLs and file references remain intact. This is a lossy context policy,
not an exactly-once image cache; its default is off. `tests/responses/upstream-history-slim.test.ts`
exercises current-turn retention, UTF-8 excerpts and destination/encoding gating.
Socket continuation follows the [incremental contract](#incremental-websocket-continuation).

## Configuration

`src/config/schema/config-schema.ts` declares the optional `upstreamHistorySlim` enum, which defaults to `off`; `codex` selects the explicitly
lossy outbound history policy described in [Responses transport](responses.md#responses-httpsse).
Invalid disk values disable the option; candidate writes reject them. The live state-store
registration in `src/lib/state-store-registrations.ts` binds the policy without editing retained conversation data.
`codexWsIncrementalUpload` is a default-off boolean and implies socket reuse after reload;
the [incremental transport contract](#incremental-websocket-continuation)
owns completed-state, retention limits, counters and fallback behavior.
