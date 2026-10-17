import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  type HookEvent, isAuthorized, MAX_NOTIFICATION_BYTES, NotificationBridge, parseHookEvent,
} from '../src/bridge';

const permission: HookEvent = {
  provider: 'codex',
  kind: 'permission', sessionId: 'session-123', requestId: 'request-456',
  cwd: '/project with spaces', toolName: 'Bash',
};

interface Reply { status: number; body: string }

function post(
  url: string, token: string, body: string,
  headers: Record<string, string> = {}, method = 'POST',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { responseBody += chunk; });
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('bridge authentication rejects absent, malformed, and incorrect tokens', () => {
  const token = 'a'.repeat(64);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  for (const header of [undefined, token, `bearer ${token}`, `Bearer ${'b'.repeat(64)}`, `Bearer ${token} `]) {
    assert.equal(isAuthorized(header, token), false);
  }
});

test('hook parser preserves only minimal metadata without original tool arguments', () => {
  assert.deepEqual(parseHookEvent({
    ...permission, tool_input: { command: 'SECRET' }, token: 'SECRET', message: 'SECRET',
  }), permission);
  assert.deepEqual(parseHookEvent({ ...permission, kind: 'question', toolName: 'request_user_input_async' }), {
    ...permission, kind: 'question', toolName: 'request_user_input_async',
  });
  for (const event of [null, [], {}, { ...permission, kind: 'other' }, { ...permission, provider: 'unknown' }, { ...permission, provider: null }]) {
    assert.equal(parseHookEvent(event), undefined);
  }
  for (const key of ['sessionId', 'requestId', 'cwd', 'toolName']) {
    const limit = key === 'cwd' ? 4096 : 200;
    for (const value of [undefined, null, 7, '', '   ', 'bad\u001bvalue', 'bad\nvalue', 'x'.repeat(limit + 1)]) {
      assert.equal(parseHookEvent({ ...permission, [key]: value }), undefined, `${key}: ${String(value).slice(0, 20)}`);
    }
    assert.ok(parseHookEvent({ ...permission, [key]: 'x'.repeat(limit) }));
  }
});

test('legacy Codex events remain supported and Claude question permissions are normalized', () => {
  const { provider: _provider, ...legacy } = permission;
  assert.deepEqual(parseHookEvent(legacy), permission);
  assert.deepEqual(parseHookEvent({ ...permission, provider: 'claude', toolName: 'AskUserQuestion' }), {
    ...permission, provider: 'claude', toolName: 'AskUserQuestion', kind: 'question',
  });
});

test('bridge routes Claude metadata and never approves AskUserQuestion permission events', async () => {
  const received: HookEvent[] = [];
  const bridge = new NotificationBridge(async (event) => { received.push(event); return { allow: true }; }, () => {});
  try {
    const { url, token } = await bridge.start();
    const claude = { ...permission, provider: 'claude', toolName: 'Write' };
    assert.deepEqual(JSON.parse((await post(url, token, JSON.stringify(claude))).body), { allow: true });
    assert.deepEqual(received[0], claude);
    const question = { ...claude, toolName: 'AskUserQuestion' };
    assert.deepEqual(JSON.parse((await post(url, token, JSON.stringify(question))).body), { allow: false });
    assert.equal(received[1]!.kind, 'question');
  } finally { bridge.dispose(); }
});

test('HTTP bridge authenticates native Codex events and rejects invalid requests', async () => {
  const received: HookEvent[] = [];
  const bridge = new NotificationBridge(async (event) => {
    received.push(event);
    return { allow: true };
  }, () => {});
  try {
    const { url, token } = await bridge.start();
    assert.deepEqual(await bridge.start(), { url, token });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/notify$/);
    assert.match(token, /^[a-f0-9]{64}$/);
    const body = JSON.stringify(permission);
    assert.equal((await post(url, 'invalid', body)).status, 401);
    assert.equal((await post(url.replace('/notify', '/other'), token, body)).status, 404);
    assert.equal((await post(url, token, body, {}, 'GET')).status, 404);
    assert.equal((await post(url, token, body, { Origin: 'http://localhost' })).status, 403);
    assert.equal((await post(url, token, 'invalid JSON')).status, 400);
    assert.equal((await post(url, token, JSON.stringify({ ...permission, sessionId: 123 }))).status, 400);
    assert.equal((await post(url, token, body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(url, token, ' '.repeat(MAX_NOTIFICATION_BYTES + 1))).status, 413);
    const accepted = await post(url, token, JSON.stringify({ ...permission, tool_input: { command: 'SECRET' } }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { allow: true });
    assert.deepEqual(received, [permission]);
  } finally { bridge.dispose(); }
  bridge.dispose();
  await assert.rejects(bridge.start(), /disposed/);
});

test('chunked oversized input is rejected before invoking the callback', async () => {
  let calls = 0;
  const bridge = new NotificationBridge(async () => { calls++; return { allow: true }; }, () => {});
  try {
    const { url, token } = await bridge.start();
    const reply = await post(url, token, 'x'.repeat(MAX_NOTIFICATION_BYTES + 1), { 'Transfer-Encoding': 'chunked' });
    assert.equal(reply.status, 413);
    assert.equal(calls, 0);
  } finally { bridge.dispose(); }
});

test('question events always return false even when a callback requests approval', async () => {
  const bridge = new NotificationBridge(async () => ({ allow: true }), () => {});
  try {
    const { url, token } = await bridge.start();
    const reply = await post(url, token, JSON.stringify({ ...permission, kind: 'question' }));
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { allow: false });
  } finally { bridge.dispose(); }
});

test('callback rejections and synchronous throws return false without leaking errors', async () => {
  for (const synchronous of [false, true]) {
    const logs: string[] = [];
    const bridge = new NotificationBridge(() => {
      if (synchronous) throw new Error('SECRET');
      return Promise.reject(new Error('SECRET'));
    }, (message) => logs.push(message));
    try {
      const { url, token } = await bridge.start();
      const reply = await post(url, token, JSON.stringify(permission));
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), { allow: false });
      assert.equal(logs.length, 1);
      assert.ok(!logs[0]!.includes('SECRET'));
    } finally { bridge.dispose(); }
  }
});

test('callback may wait past the input timeout while the response stays pending', { timeout: 5000 }, async () => {
  let complete: ((decision: { allow: boolean }) => void) | undefined;
  let entered: (() => void) | undefined;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  const bridge = new NotificationBridge(async () => {
    entered!();
    return new Promise((resolve) => { complete = resolve; });
  }, () => {});
  try {
    const { url, token } = await bridge.start();
    let resolved = false;
    const reply = post(url, token, JSON.stringify(permission)).then((value) => { resolved = true; return value; });
    await callbackEntered;
    await delay(2100);
    assert.equal(resolved, false);
    complete!({ allow: true });
    assert.deepEqual(JSON.parse((await reply).body), { allow: true });
  } finally { bridge.dispose(); }
});

test('client disconnect aborts a pending callback', { timeout: 3000 }, async () => {
  let entered: (() => void) | undefined;
  let aborted: (() => void) | undefined;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  const callbackAborted = new Promise<void>((resolve) => { aborted = resolve; });
  const bridge = new NotificationBridge(async (_event, signal) => {
    entered!();
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted!(); resolve({ allow: true }); }, { once: true });
    });
  }, () => {});
  try {
    const { url, token } = await bridge.start();
    const req = request(url, {
      method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    req.on('error', () => {});
    req.end(JSON.stringify(permission));
    await callbackEntered;
    req.destroy();
    await callbackAborted;
  } finally { bridge.dispose(); }
});

test('dispose aborts active callbacks and never returns approval after cancellation', { timeout: 3000 }, async () => {
  let entered: (() => void) | undefined;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const bridge = new NotificationBridge(async (_event, activeSignal) => {
    signal = activeSignal;
    entered!();
    return new Promise((resolve) => {
      activeSignal.addEventListener('abort', () => resolve({ allow: true }), { once: true });
    });
  }, () => {});
  try {
    const { url, token } = await bridge.start();
    const reply = post(url, token, JSON.stringify(permission)).catch(() => undefined);
    await callbackEntered;
    bridge.dispose();
    assert.equal(signal?.aborted, true);
    const received = await reply;
    if (received) assert.deepEqual(JSON.parse(received.body), { allow: false });
  } finally { bridge.dispose(); }
});

test('disposing during startup rejects instead of leaving a pending promise', async () => {
  const bridge = new NotificationBridge(async () => ({ allow: false }), () => {});
  const pending = bridge.start();
  bridge.dispose();
  await assert.rejects(pending, /disposed/);
});
