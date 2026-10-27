import { test, expect, beforeEach, afterAll } from 'bun:test';
import { prepareIncrementalFrame as prepare, completeIncrementalFrame as complete,
  setCodexWsIncrementalUpload as enable, forgetIncrementalSession as forget,
  codexWsIncrementalStats as stats } from '../../src/server/responses/codex-ws-incremental';
import { codexWsCreateFrameExceedsLimit } from '../../src/server/responses/codex-ws-wire';
import { codexWsReuseIdentity } from '../../src/server/responses/codex-ws-pool';
import { setCodexWsReuseAcrossTurns } from '../../src/config/codex-ws-reuse-setting';
import { slimCodexHistoryJson } from '../../src/server/responses/history-slim';
import { codexWsUpstreamFetch } from '../../src/server/responses/ws-upstream';
import { codexWsPool } from '../../src/server/responses/codex-ws-pool';
beforeEach(() => { enable(true); setCodexWsReuseAcrossTurns(true); });
afterAll(() => { enable(false); setCodexWsReuseAcrossTurns(false); });
const message = (role: string, text: string) => ({ type: 'message', role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const envelope = { type: 'response.create', model: 'gpt-6.1-sol', store: false, instructions: 'keep context',
  tools: [], client_metadata: { thread_id: 'thread-1', turn_id: 'turn-1' } };
const frame = (input: any[], extras = {}) => JSON.stringify({ ...envelope, ...extras, input });
const answer = { ...message('assistant', 'hello'), id: 'msg-server', status: 'completed' };
function seed(session: object, input = [message('user', 'prefix')]) {
  const plan = prepare(session, frame(input))!;
  complete(plan, { id: 'resp-original', status: 'completed', output: [answer] });
  return input;
}
test('only acknowledged output anchors an exact prefix and new turn metadata permits delta', () => {
  const session = {}; const input = seed(session);
  const plan = prepare(session, frame([...input, message('assistant', 'hello'), message('user', 'next')],
    { client_metadata: { thread_id: 'thread-1', turn_id: 'turn-2' } }))!;
  expect(plan.delta).toBe(true);
  expect(JSON.parse(plan.frameText).previous_response_id).toBe('resp-original');
  expect(JSON.parse(plan.frameText).input).toEqual([message('user', 'next')]);
  forget(session);
});
test('edited history, changed instructions and tool arguments preserve full requests', () => {
  for (const change of ['prefix', 'instructions', 'tools']) {
    const session = {}; const input = seed(session);
    const text = frame([...(change === 'prefix' ? [message('user', 'edited')] : input), answer, message('user', 'next')],
      change === 'instructions' ? { instructions: 'new policy' } : change === 'tools' ? { tools: [{ name: 'new-tool' }] } : {});
    const plan = prepare(session, text)!;
    expect(plan.delta).toBe(false); expect(plan.frameText).toBe(text); forget(session);
  }
});
test('UNKNOWN and failed turns cannot seed future deltas; disposed sessions lose state', () => {
  const session = {}; const first = prepare(session, frame([message('user', 'prefix')]))!;
  complete(first, { id: 'resp-failed', status: 'failed', output: [answer] });
  expect(prepare(session, frame([message('user', 'prefix'), answer, message('user', 'next')]))!.delta).toBe(false);
  seed(session); forget(session);
  expect(prepare(session, frame([message('user', 'prefix'), answer, message('user', 'next')]))!.delta).toBe(false);
});
test('account, thread and proxy changes cannot claim the previous socket identity', () => {
  const url = 'https://chatgpt.com/backend-api/codex/responses';
  const headers = { authorization: 'Bearer fake-account-one', 'chatgpt-account-id': 'acct-one', 'thread-id': 'thread-1' };
  const text = frame([message('user', 'hello')]);
  const first = codexWsReuseIdentity(url, headers, text, 'http://proxy-one')!;
  expect(first).not.toBeNull();
  expect(codexWsReuseIdentity(url, { ...headers, authorization: 'Bearer fake-two' }, text, 'http://proxy-one')!.key).not.toBe(first.key);
  expect(codexWsReuseIdentity(url, { ...headers, 'chatgpt-account-id': 'acct-two' }, text, 'http://proxy-one')!.scope).not.toBe(first.scope);
  expect(codexWsReuseIdentity(url, headers, frame([message('user', 'hello')], { client_metadata: { thread_id: 'thread-2', turn_id: 'turn-1' } }), 'http://proxy-one')).toBeNull();
  expect(codexWsReuseIdentity(url, headers, text, 'http://proxy-two')!.key).not.toBe(first.key);
});
test('a full history above WS frame limit can produce a small delta on an established chain', () => {
  const session = {}; const big = message('user', 'A'.repeat(8 * 1024 * 1024));
  const first = prepare(session, frame([big]))!;
  complete(first, { id: 'resp-big', status: 'completed', output: [answer] });
  const full = frame([big, answer, message('user', 'B'.repeat(8 * 1024 * 1024))]);
  const delta = prepare(session, full)!;
  expect(codexWsCreateFrameExceedsLimit(full)).toBe(true);
  expect(delta.delta).toBe(true);
  expect(codexWsCreateFrameExceedsLimit(delta.frameText)).toBe(false);
  forget(session);
});
test('pre-existing stateful lanes and disabled feature remain untouched', () => {
  expect(prepare({}, frame([message('user', 'delta')], { previous_response_id: 'already-owned' }))).toBeUndefined();
  expect(prepare({}, frame([message('user', 'delta')], { stream_id: 'native-lane' }))).toBeUndefined();
  enable(false); expect(prepare({}, frame([message('user', 'hello')]))).toBeUndefined(); enable(true);
  expect(stats().retainedBytes).toBe(0);
});
test('item-reference ids remain semantic while server-only assistant timestamps may be absent', () => {
  const session = {}; const first = prepare(session, frame([{ type: 'item_reference', id: 'item-one' }]))!;
  complete(first, { id: 'resp-ref', status: 'completed', output: [{ ...answer,
    metadata: { turn_id: 'server-turn' }, internal_chat_message_metadata_passthrough: { create_time: 123, turn_id: 'server-turn' } }] });
  const same = prepare(session, frame([{ type: 'item_reference', id: 'item-one' }, message('assistant', 'hello'), message('user', 'next')]))!;
  expect(same.delta).toBe(true);
  complete(first, { id: 'resp-ref', status: 'completed', output: [answer] });
  const edited = prepare(session, frame([{ type: 'item_reference', id: 'item-two' }, message('assistant', 'hello'), message('user', 'next')]))!;
  expect(edited.delta).toBe(false); forget(session);
});
test('image-once policy composes with delta: tool continuation omits image, later policy reset sends a stub', () => {
  const session = {};
  const image = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(2048) }] };
  const call = { type: 'function_call', call_id: 'call-image', name: 'inspect', arguments: '{}' };
  const firstFrame = frame([image]);
  expect(slimCodexHistoryJson(firstFrame)).toBeNull();
  const first = prepare(session, firstFrame)!;
  complete(first, { id: 'resp-image', status: 'completed', output: [call] });
  const output = { type: 'function_call_output', call_id: 'call-image', output: 'inspection done' };
  const toolFrame = frame([image, call, output]);
  expect(slimCodexHistoryJson(toolFrame)).toBeNull();
  const continuation = prepare(session, toolFrame)!;
  expect(continuation.delta).toBe(true);
  expect(JSON.parse(continuation.frameText).input).toEqual([output]);
  expect(continuation.frameText).not.toContain('data:image');
  complete(continuation, { id: 'resp-tool', status: 'completed', output: [answer] });
  const next = slimCodexHistoryJson(frame([image, call, output, answer, message('user', 'new user turn')]))!;
  expect(next).toContain('image omitted');
  const reset = prepare(session, next)!;
  expect(reset.delta).toBe(false);
  expect(reset.frameText).not.toContain('data:image');
  forget(session);
});
test('empty reasoning content is equivalent to omission; ciphertext and nonempty content stay exact', () => {
  const input = [message('user', 'reasoning test')];
  const reasoning = { type: 'reasoning', id: 'rs-one', summary: [], content: [], encrypted_content: 'opaque-same-ciphertext' };
  const session = {};
  const first = prepare(session, frame(input))!;
  complete(first, { id: 'resp-reason', status: 'completed', output: [reasoning, answer] });
  const { content, ...clientReasoning } = reasoning;
  const same = prepare(session, frame([...input, clientReasoning, answer, message('user', 'next')]))!;
  expect(same.delta).toBe(true);
  complete(first, { id: 'resp-reason', status: 'completed', output: [reasoning, answer] });
  const changed = prepare(session, frame([...input, { ...clientReasoning, encrypted_content: 'changed-ciphertext' }, answer, message('user', 'next')]))!;
  expect(changed.delta).toBe(false);
  complete(first, { id: 'resp-reason', status: 'completed', output: [reasoning, answer] });
  const nonempty = prepare(session, frame([...input, { ...clientReasoning, content: [{ type: 'reasoning_text', text: 'changed text' }] }, answer, message('user', 'next')]))!;
  expect(nonempty.delta).toBe(false); forget(session);
});

test('physical WS exchange sends delta on the same explicit proxy and new request id', async () => {
  const original = globalThis.WebSocket;
  const keys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    readyState = 0;
    frames: any[] = [];
    constructor(readonly url: string, readonly options: { proxy?: string }) {
      super(); sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(text: string) {
      this.frames.push(JSON.parse(text));
      const id = 'response-' + this.frames.length;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id } }) }));
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [answer] } }) }));
      });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    ref() {}
    unref() {}
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  let fallbackCalls = 0;
  const fallback = (async () => { fallbackCalls++; return new Response('unexpected'); }) as typeof fetch;
  const init = (input: any[], request: string): RequestInit => ({ method: 'POST',
    headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account',
      'thread-id': 'thread-1', 'x-client-request-id': request },
    body: JSON.stringify({ ...envelope, type: undefined, stream: true, input }) });
  const run = (input: any[], request: string) => codexWsUpstreamFetch(
    'https://chatgpt.com/backend-api/codex/responses', init(input, request), fallback, '1.4.4',
    undefined, undefined, undefined, undefined, undefined, undefined, 'http://proxy.example:8080');
  try {
    const first = [message('user', 'retained input')];
    expect(await (await run(first, 'request-one')).text()).toContain('response.completed');
    expect(await (await run([...first, answer, message('user', 'new input')], 'request-two')).text()).toContain('response.completed');
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.options.proxy).toBe('http://proxy.example:8080');
    expect(socket.frames[1].previous_response_id).toBe('response-1');
    expect(socket.frames[1].input).toEqual([message('user', 'new input')]);
    expect(socket.frames[1].client_metadata['x-client-request-id']).toBe('request-two');
    // Dispose the acknowledged socket: a new connection must start with full history.
    codexWsPool.dispose();
    const full = [...first, answer, message('user', 'new input'), answer, message('user', 'after disconnect')];
    await (await run(full, 'request-three')).text();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.frames[0].previous_response_id).toBeUndefined();
    expect(sockets[1]!.frames[0].input).toEqual(full);
    expect(fallbackCalls).toBe(0);
  } finally {
    codexWsPool.dispose(); globalThis.WebSocket = original;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
