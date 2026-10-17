import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { approvalOutput, discoverEndpoints, MAX_ENDPOINT_AGE_MS, MAX_INPUT_BYTES, normalizeHookEvent, parseEndpoint, postHookEvent, readBoundedInput, runHookClient, selectEndpoint, selectEndpoints, type HookEvent, type HttpRequest, type RegistryEndpoint } from '../src/hook-client';

const cwd = path.join(os.tmpdir(), 'agent-alert-hook-project');
const rawEvent = { hook_event_name: 'PermissionRequest', session_id: 'session-123', cwd, tool_name: 'exec_command', tool_input: { command: 'secret command' }, transcript_path: '/private/transcript' };
const permission: HookEvent = { provider: 'codex', kind: 'permission', sessionId: 'session-123', requestId: 'request-123', cwd, toolName: 'exec_command' };
function endpoint(workspaces: string[] = [cwd], createdAt = Date.now(), port = 4444): RegistryEndpoint {
  return { url: `http://127.0.0.1:${port}/notify`, token: 'a'.repeat(64), workspaces, createdAt };
}

test('hook normalization accepts only permission events and explicit question tools, with no private input', () => {
  assert.deepEqual(normalizeHookEvent(rawEvent, () => 'request-123'), permission);
  assert.equal(JSON.stringify(normalizeHookEvent(rawEvent)).includes('secret'), false);
  for (const tool_name of ['request_user_input', 'request_user_input_async', 'functions.request_user_input', 'functions.request_user_input_async', 'other.request_user_input', 'mcp__codex_request_user_input_async']) {
    assert.equal(normalizeHookEvent({ ...rawEvent, hook_event_name: 'PreToolUse', tool_name })?.kind, 'question');
  }
  for (const event of [null, [], {}, { ...rawEvent, session_id: '' }, { ...rawEvent, cwd: 'relative' }, { ...rawEvent, tool_name: '' }, { ...rawEvent, session_id: 'bad\nvalue' }, { ...rawEvent, hook_event_name: 'Notification' }, { ...rawEvent, hook_event_name: 'PreToolUse' }, { ...rawEvent, hook_event_name: 'PreToolUse', tool_name: 'notrequest_user_input' }]) {
    assert.equal(normalizeHookEvent(event), undefined);
  }
  assert.match(normalizeHookEvent(rawEvent)!.requestId, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
});

test('Claude hooks identify their provider and recognize AskUserQuestion on both hook paths', () => {
  for (const hook_event_name of ['PreToolUse', 'PermissionRequest']) {
    const event = normalizeHookEvent({ ...rawEvent, hook_event_name, tool_name: 'AskUserQuestion', provider: 'codex' }, () => 'id', 'claude');
    assert.deepEqual(event, { ...permission, provider: 'claude', requestId: 'id', kind: 'question', toolName: 'AskUserQuestion' });
    assert.equal(approvalOutput(event!, true), undefined);
  }
  for (const tool_name of ['Bash', 'Edit', 'Write']) {
    const event = normalizeHookEvent({ ...rawEvent, tool_name }, () => 'id', 'claude');
    assert.equal(event?.kind, 'permission');
    assert.equal(event?.provider, 'claude');
  }
  for (const tool_name of ['request_user_input', 'mcp__x__AskUserQuestion', 'AskUserQuestionExtra', 'Bash']) {
    assert.equal(normalizeHookEvent({ ...rawEvent, hook_event_name: 'PreToolUse', tool_name }, undefined, 'claude'), undefined);
  }
  assert.equal(normalizeHookEvent({ ...rawEvent, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), undefined);
  assert.equal(approvalOutput({ ...permission, provider: 'claude', toolName: 'AskUserQuestion' }, true), undefined);
});

test('Claude routing requires explicit endpoint support and never uses an old Codex window', async () => {
  const now = Date.now();
  const legacy = endpoint([cwd], now, 4444);
  const modern: RegistryEndpoint = { ...endpoint([cwd], now + 1, 5555), providers: ['codex', 'claude'] };
  assert.equal(await selectEndpoint([legacy], cwd, now, undefined, 'claude'), undefined);
  assert.deepEqual(await selectEndpoint([legacy], cwd, now), legacy);
  assert.deepEqual(await selectEndpoint([legacy, modern], cwd, now, undefined, 'claude'), modern);
  assert.deepEqual(await selectEndpoint([modern, modern], cwd, now, undefined, 'claude'), modern);
  assert.deepEqual(await selectEndpoint([legacy, modern], cwd, now), modern);
  for (const providers of [null, [], ['unknown'], ['claude', 1], 'claude']) {
    assert.equal(parseEndpoint({ ...legacy, providers }), undefined);
  }
});

test('Claude client uses the command marker, declines ambiguous markers, and never outputs a question answer', async () => {
  const output: string[] = [];
  const posted: HookEvent[] = [];
  const run = (toolName: string, markers = ['--agent-alert-claude'], providers?: ('claude' | 'codex')[]) => runHookClient({
    args: ['--registry', os.tmpdir(), ...markers],
    input: Readable.from([JSON.stringify({ ...rawEvent, tool_name: toolName })]),
    discover: async () => [{ ...endpoint(), providers }],
    post: async (_endpoint, event) => { posted.push(event); return true; },
    write: (value) => { output.push(value); },
  });
  await run('Bash', ['--agent-alert-claude'], ['codex', 'claude']);
  assert.equal(posted[0]?.provider, 'claude');
  assert.deepEqual(output, ['{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}']);
  await run('AskUserQuestion', ['--agent-alert-claude'], ['claude']);
  assert.equal(posted[1]?.kind, 'question');
  await run('Bash'); // A legacy endpoint must not use the Codex allowlist for Claude.
  await run('Bash', ['--agent-alert-codex', '--agent-alert-claude'], ['claude']);
  assert.equal(posted.length, 2);
  assert.equal(output.length, 1);
});

test('endpoint parser restricts routing, tokens and freshness', () => {
  const now = Date.now();
  assert.ok(parseEndpoint(endpoint([cwd], now), now));
  for (const change of [
    { url: 'https://127.0.0.1:4444/notify' }, { url: 'http://localhost:4444/notify' },
    { url: 'http://192.168.1.1/notify' }, { url: 'http://127.0.0.1:4444/other' },
    { url: 'http://user:pass@127.0.0.1/notify' }, { url: 'http://127.0.0.1/notify?redirect=yes' },
    { token: 'x'.repeat(31) }, { token: `${'x'.repeat(40)}\r\nInjected: value` },
    { createdAt: now - MAX_ENDPOINT_AGE_MS - 1 }, { createdAt: now + 5001 },
    { workspaces: ['relative'] }, { workspaces: [] },
  ]) assert.equal(parseEndpoint({ ...endpoint([cwd], now), ...change }, now), undefined);
});

test('selection honors path segments and orders equal workspace matches newest first', async () => {
  const now = Date.now();
  const resolvePath = async (value: string): Promise<string> => path.resolve(value);
  const parent = endpoint([path.dirname(cwd)], now, 4001);
  const exact = endpoint([cwd], now, 4002);
  assert.equal((await selectEndpoint([parent, exact], path.join(cwd, 'src'), now, resolvePath))?.url, exact.url);
  assert.equal(await selectEndpoint([exact], `${cwd}-other`, now, resolvePath), undefined);
  const newer = endpoint([cwd], now + 1, 4003);
  assert.equal((await selectEndpoint([exact, newer], cwd, now, resolvePath))?.url, newer.url);
  assert.deepEqual((await selectEndpoints([parent, exact, newer], cwd, now, resolvePath)).map(value => value.url),
    [newer.url, exact.url, parent.url]);
  assert.equal(await selectEndpoint([endpoint([path.join(cwd, 'other')])], cwd, now, resolvePath), undefined);
  const alias = path.join(os.tmpdir(), 'alias');
  assert.equal((await selectEndpoint([exact], alias, now, async (value) => value === alias ? cwd : value))?.url, exact.url);
});

test('discovery reads only private owned regular fresh JSON files from its fixture directory', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-alert-hook-registry-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const good = path.join(directory, 'good.json');
  await writeFile(good, JSON.stringify(endpoint()), { mode: 0o600 });
  await writeFile(path.join(directory, 'malformed.json'), '{broken', { mode: 0o600 });
  await writeFile(path.join(directory, 'stale.json'), JSON.stringify(endpoint([cwd], Date.now() - MAX_ENDPOINT_AGE_MS - 1000)), { mode: 0o600 });
  await writeFile(path.join(directory, 'oversize.json'), 'x'.repeat(65 * 1024), { mode: 0o600 });
  if (process.platform !== 'win32') {
    const publicFile = path.join(directory, 'public.json');
    await writeFile(publicFile, JSON.stringify(endpoint()), { mode: 0o600 });
    await chmod(publicFile, 0o644);
    await symlink(good, path.join(directory, 'link.json'));
  }
  assert.equal((await discoverEndpoints(directory)).length, 1);
  assert.deepEqual(await discoverEndpoints(path.join(directory, 'missing')), []);
});

test('stdin is bounded by bytes and time without forwarding oversized input', async () => {
  assert.equal(await readBoundedInput(Readable.from(['hello'])), 'hello');
  assert.equal(await readBoundedInput(Readable.from([Buffer.alloc(MAX_INPUT_BYTES)])), '\0'.repeat(MAX_INPUT_BYTES));
  assert.equal(await readBoundedInput(Readable.from([Buffer.alloc(MAX_INPUT_BYTES + 1)])), undefined);
  const stalled = new PassThrough();
  assert.equal(await readBoundedInput(stalled, MAX_INPUT_BYTES, 15), undefined);
  assert.equal(stalled.listenerCount('data'), 0);
  stalled.destroy();
});

function fakeRequest(body: string, status = 200, contentType = 'application/json', capture?: (options: RequestOptions, body: string) => void): HttpRequest {
  return (_url, options, callback) => {
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = (() => outgoing) as ClientRequest['destroy'];
    outgoing.end = ((sent: string) => {
      capture?.(options, sent);
      queueMicrotask(() => {
        const stream = new PassThrough();
        const incoming = stream as unknown as IncomingMessage;
        incoming.statusCode = status;
        incoming.headers = { 'content-type': contentType };
        callback(incoming);
        stream.end(body);
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  };
}

test('POST authenticates only normalized metadata and accepts a bounded literal JSON allow decision', async () => {
  const selected = endpoint();
  let captured = false;
  assert.equal(await postHookEvent(selected, permission, 100, fakeRequest('{"allow":true}', 200, 'application/json; charset=utf-8', (options, body) => {
    captured = true;
    assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${selected.token}`);
    assert.deepEqual(JSON.parse(body), permission);
    assert.equal(body.includes('tool_input'), false);
  })), true);
  assert.equal(captured, true);
  for (const [body, status, contentType] of [
    ['{"allow":false}', 200, 'application/json'], ['{"allow":"true"}', 200, 'application/json'],
    ['{"allow":true}', 202, 'application/json'], ['{"allow":true}', 200, 'text/plain'],
    ['{broken', 200, 'application/json'], ['x'.repeat(1025), 200, 'application/json'],
  ] as const) assert.equal(await postHookEvent(selected, permission, 100, fakeRequest(body, status, contentType)), false);
  assert.equal(await postHookEvent(selected, permission, 15, () => {
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = (() => outgoing) as ClientRequest['end'];
    outgoing.destroy = (() => outgoing) as ClientRequest['destroy'];
    return outgoing;
  }), false);
});

test('question events never produce approval output, even if the server says allow', () => {
  assert.equal(approvalOutput(permission, true), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.equal(approvalOutput({ ...permission, kind: 'question' }, true), undefined);
  assert.equal(approvalOutput(permission, 'true'), undefined);
});

test('client end-to-end with injected transport emits only explicit permission approval', async () => {
  const output: string[] = [];
  let posted: HookEvent | undefined;
  const run = async (event: unknown, candidates = [endpoint()]): Promise<void> => runHookClient({
    args: ['--registry', os.tmpdir(), '--agent-alert-codex'], input: Readable.from([JSON.stringify(event)]),
    write: (value) => { output.push(value); }, discover: async () => candidates,
    post: async (_endpoint, received) => { posted = received; return true; },
  });
  await run(rawEvent);
  assert.equal(output.length, 1);
  assert.equal(posted?.kind, 'permission');
  assert.equal(JSON.stringify(posted).includes('secret'), false);
  await run({ ...rawEvent, hook_event_name: 'PreToolUse', tool_name: 'request_user_input' });
  await run(rawEvent, [endpoint([path.join(cwd, 'different')])]);
  await run(rawEvent, [endpoint(), endpoint([cwd], Date.now(), 5555)]);
  assert.equal(output.length, 2);
});

test('client falls through dead IDEs, notifies equal live IDEs, and stops after approval', async () => {
  const first = endpoint([cwd], Date.now(), 4001);
  const second = endpoint([cwd], first.createdAt - 1, 4002);
  const parent = endpoint([path.dirname(cwd)], first.createdAt, 4003);
  const posted: string[] = [];
  const output: string[] = [];
  await runHookClient({
    args: ['--registry', os.tmpdir(), '--agent-alert-codex'], input: Readable.from([JSON.stringify(rawEvent)]),
    discover: async () => [parent, second, first],
    post: async (candidate) => {
      posted.push(new URL(candidate.url).port);
      if (candidate.url === first.url) return { delivered: false, allow: false };
      return { delivered: true, allow: candidate.url === second.url };
    },
    write: value => { output.push(value); },
  });
  assert.deepEqual(posted, ['4001', '4002']);
  assert.equal(output.length, 1);
});

test('malformed input, unavailable registries, and the overall deadline remain quiet', async () => {
  const output: string[] = [];
  await runHookClient({ args: ['--registry', os.tmpdir()], input: Readable.from(['{broken']), write: (value) => { output.push(value); } });
  await runHookClient({ args: ['--registry', os.tmpdir()], input: Readable.from([JSON.stringify(rawEvent)]), discover: async () => { throw new Error('unavailable'); }, write: (value) => { output.push(value); } });
  await runHookClient({ args: ['--registry', os.tmpdir()], input: Readable.from([JSON.stringify(rawEvent)]), discover: async () => new Promise(() => undefined), timeoutMs: 15, write: (value) => { output.push(value); } });
  assert.deepEqual(output, []);
});
