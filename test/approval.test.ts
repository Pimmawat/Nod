import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalController, canAutoApprove, type ApprovalSettings } from '../src/approval';
import type { HookEvent } from '../src/bridge';

const event: HookEvent = { provider: 'codex', kind: 'permission', sessionId: 's1', requestId: 'r1', cwd: '/project', toolName: 'Bash' };
function fixture(overrides: Partial<ApprovalSettings> = {}) {
  const settings: ApprovalSettings = { enabled: true, armed: true, allowedTools: ['Bash'], delayMs: 3000, ...overrides };
  const timers = new Map<number, () => void>();
  let next = 0;
  const notices: boolean[] = [];
  const approved: HookEvent[] = [];
  const controller = new ApprovalController({
    settings: () => settings,
    notify: (_event, automatic) => { notices.push(automatic); },
    approved: (request) => { approved.push(request); },
    schedule: (callback) => { const id = ++next; timers.set(id, callback); return () => { timers.delete(id); }; },
  });
  return { settings, notices, approved, controller, timers, tick: () => { for (const callback of [...timers.values()]) callback(); } };
}

test('approves only eligible tools after the delay', async () => {
  const f = fixture();
  const result = f.controller.handle(event, new AbortController().signal);
  assert.equal(f.approved.length, 0);
  assert.deepEqual(f.notices, [true]);
  f.tick();
  assert.deepEqual(await result, { allow: true });
  assert.equal(f.approved.length, 1);
});

test('disarmed windows, unknown tools and questions never auto approve', async () => {
  for (const [request, overrides] of [
    [event, { armed: false }],
    [{ ...event, toolName: 'mcp__deploy' }, {}],
    [{ ...event, kind: 'question', toolName: 'request_user_input' }, { allowedTools: ['*'] }],
  ] as [HookEvent, Partial<ApprovalSettings>][]) {
    const f = fixture(overrides);
    assert.deepEqual(await f.controller.handle(request, new AbortController().signal), { allow: false });
    assert.deepEqual(f.notices, [false]);
    assert.equal(f.timers.size, 0);
  }
});

test('disconnect, stop, settings changes and disposal cancel pending approvals', async () => {
  for (const action of ['abort', 'stop', 'disable', 'tools', 'dispose']) {
    const f = fixture();
    const abort = new AbortController();
    const result = f.controller.handle(event, abort.signal);
    if (action === 'abort') abort.abort();
    if (action === 'stop') f.controller.cancelAll();
    if (action === 'disable') f.settings.armed = false;
    if (action === 'tools') f.settings.allowedTools = [];
    if (action === 'dispose') f.controller.dispose();
    f.tick();
    assert.deepEqual(await result, { allow: false }, action);
    assert.equal(f.approved.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('replayed requests cannot approve or alert twice', async () => {
  const f = fixture();
  const result = f.controller.handle(event, new AbortController().signal);
  assert.deepEqual(await f.controller.handle(event, new AbortController().signal), { allow: false });
  f.tick();
  assert.deepEqual(await result, { allow: true });
  assert.equal(f.notices.length, 1);
});

test('tool matching is exact, wildcard applies only to permissions', () => {
  const f = fixture();
  assert.equal(canAutoApprove({ ...event, toolName: 'BashDangerous' }, f.settings), false);
  assert.equal(canAutoApprove(event, { ...f.settings, allowedTools: ['B*'] }), false);
  assert.equal(canAutoApprove(event, { ...f.settings, allowedTools: ['*'] }), true);
  assert.equal(canAutoApprove({ ...event, kind: 'question' }, { ...f.settings, allowedTools: ['*'] }), false);
});

test('Claude approvals require their own allowlist, even when Codex allows all tools', async () => {
  const request: HookEvent = { ...event, provider: 'claude' };
  const f = fixture({ allowedTools: ['*'] });
  assert.deepEqual(await f.controller.handle(request, new AbortController().signal), { allow: false });
  assert.deepEqual(f.notices, [false]);
  assert.equal(f.timers.size, 0);
  const enabled = fixture({ allowedTools: [], claudeAllowedTools: ['Bash'] });
  const result = enabled.controller.handle(request, new AbortController().signal);
  assert.deepEqual(enabled.notices, [true]);
  enabled.tick();
  assert.deepEqual(await result, { allow: true });
  assert.equal(canAutoApprove(event, enabled.settings), false);
  assert.equal(canAutoApprove({ ...request, toolName: 'BashOther' }, enabled.settings), false);
});

test('question tools are protected even if labelled as permission requests and wildcard is armed', () => {
  const settings = fixture({ allowedTools: ['*'], claudeAllowedTools: ['*'] }).settings;
  assert.equal(canAutoApprove({ ...event, toolName: 'request_user_input' }, settings), false);
  assert.equal(canAutoApprove({ ...event, provider: 'claude', toolName: 'AskUserQuestion' }, settings), false);
  assert.equal(canAutoApprove({ ...event, provider: 'claude', toolName: 'Write' }, settings), true);
});

test('Claude pending approvals cancel on stop, disconnect, disabling, and allowlist changes', async () => {
  for (const action of ['stop', 'abort', 'disable', 'tools', 'dispose']) {
    const f = fixture({ claudeAllowedTools: ['Bash'] });
    const abort = new AbortController();
    const result = f.controller.handle({ ...event, provider: 'claude' }, abort.signal);
    if (action === 'stop') f.controller.cancelAll();
    if (action === 'abort') abort.abort();
    if (action === 'disable') f.settings.armed = false;
    if (action === 'tools') f.settings.claudeAllowedTools = [];
    if (action === 'dispose') f.controller.dispose();
    f.tick();
    assert.deepEqual(await result, { allow: false }, action);
    assert.equal(f.approved.length, 0);
  }
});

test('identical IDs in different agents do not suppress each other', async () => {
  const f = fixture({ armed: false });
  await f.controller.handle(event, new AbortController().signal);
  await f.controller.handle({ ...event, provider: 'claude' }, new AbortController().signal);
  assert.deepEqual(f.notices, [false, false]);
});
