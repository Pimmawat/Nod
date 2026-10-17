import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApprovalController, type ApprovalSettings } from '../src/approval';
import { NotificationBridge, type HookEvent } from '../src/bridge';

interface ChildResult { code: number | null; stdout: string; stderr: string }

for (const provider of ['codex', 'claude'] as const) {
test(`${provider} hook subprocess routes permissions and questions through the bridge and approval controller`, { timeout: 15_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-alert-hook-e2e-'));
  const workspace = path.join(directory, 'workspace with spaces');
  const registry = path.join(directory, 'registry');
  const children = new Set<ChildProcess>();
  const settings: ApprovalSettings = { enabled: true, armed: true, allowedTools: ['exec_command'], claudeAllowedTools: ['Bash'], delayMs: 3000 };
  const notices: { event: HookEvent; automatic: boolean }[] = [];
  const approved: HookEvent[] = [];
  const schedules = new Set<() => void>();
  const scheduler = new EventEmitter();
  const controller = new ApprovalController({
    settings: () => settings,
    notify: (event, automatic) => { notices.push({ event, automatic }); },
    approved: (event) => { approved.push(event); },
    schedule: (callback, delay) => {
      assert.equal(delay, 3000);
      schedules.add(callback);
      scheduler.emit('scheduled');
      return () => { schedules.delete(callback); };
    },
  });
  const logs: string[] = [];
  const bridge = new NotificationBridge((event, signal) => controller.handle(event, signal), (message) => { logs.push(message); });
  context.after(async () => {
    controller.dispose();
    bridge.dispose();
    await Promise.all([...children].map(async (child) => {
      const closed = once(child, 'close').catch(() => undefined);
      child.kill();
      await closed;
    }));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(workspace);
  await mkdir(registry, { mode: 0o700 });
  const endpoint = await bridge.start();
  await writeFile(path.join(registry, 'window.json'), JSON.stringify({ ...endpoint, providers: ['codex', 'claude'], workspaces: [workspace], createdAt: Date.now() }), { mode: 0o600 });

  const raw = {
    hook_event_name: 'PermissionRequest', session_id: 'integration-session',
    cwd: workspace, tool_name: provider === 'claude' ? 'Bash' : 'exec_command',
    tool_input: { command: 'PRIVATE_TOOL_ARGUMENTS', largeArgument: 'x'.repeat(128 * 1024) },
  };
  const startClient = (event: unknown): { completed: Promise<ChildResult>; stdout: () => string } => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/hook-client.js'), '--registry', registry, `--agent-alert-${provider}`], {
      cwd: workspace,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // A failed spawn or unexpected early process exit must not leave stdin errors unhandled.
    child.stdin.on('error', () => {});
    const completed = new Promise<ChildResult>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook subprocess did not finish.')); }, 5000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
    child.stdin.end(JSON.stringify(event));
    return { completed, stdout: () => stdout };
  };
  const assertQuiet = (result: ChildResult): void => {
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  };

  const scheduled = once(scheduler, 'scheduled');
  const permission = startClient(raw);
  await scheduled;
  assert.equal(permission.stdout(), '');
  assert.equal(approved.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.automatic, true);
  assert.equal(JSON.stringify(notices).includes('PRIVATE_TOOL_ARGUMENTS'), false);
  assert.deepEqual(Object.keys(notices[0]!.event).sort(), ['cwd', 'kind', 'provider', 'requestId', 'sessionId', 'toolName']);
  assert.equal(notices[0]!.event.provider, provider);
  for (const callback of [...schedules]) callback();
  assert.deepEqual(await permission.completed, {
    code: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    stderr: '',
  });
  assert.equal(approved.length, 1);
  assert.equal(schedules.size, 0);

  assertQuiet(await startClient({ ...raw, hook_event_name: 'PreToolUse', tool_name: provider === 'claude' ? 'AskUserQuestion' : 'mcp__codex_request_user_input_async' }).completed);
  assert.equal(notices.length, 2);
  assert.equal(notices[1]!.event.kind, 'question');
  assert.equal(notices[1]!.automatic, false);
  assert.equal(schedules.size, 0);
  assert.equal(approved.length, 1);

  settings.armed = false;
  assertQuiet(await startClient(raw).completed);
  assert.equal(notices.length, 3);
  assert.equal(notices[2]!.automatic, false);
  assert.equal(approved.length, 1);

  assertQuiet(await startClient({ ...raw, cwd: `${workspace}-foreign` }).completed);
  assert.equal(notices.length, 3);

  settings.armed = true;
  const cancellationScheduled = once(scheduler, 'scheduled');
  const cancelled = startClient(raw);
  await cancellationScheduled;
  controller.cancelAll();
  assertQuiet(await cancelled.completed);
  assert.equal(approved.length, 1);
  assert.equal(schedules.size, 0);
  assert.equal(notices.length, 4);

  bridge.dispose();
  assertQuiet(await startClient(raw).completed);
  assert.equal(notices.length, 4);
  assert.deepEqual(logs, []);
});
}
