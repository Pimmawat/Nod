import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type * as vscode from 'vscode';
import { discoverEndpoints, postHookEvent } from '../src/hook-client';

async function fixture(t: TestContext, options: {
  directory?: string; values?: Record<string, unknown>; state?: Map<string, unknown>;
  globalState?: Map<string, unknown>; installed?: string[]; trusted?: boolean; remote?: boolean;
  version?: string;
} = {}) {
  const directory = options.directory ?? await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-alert-startup-')));
  const claudeHome = path.join(directory, 'claude');
  const codexHome = path.join(directory, 'codex');
  const storage = path.join(directory, 'storage');
  const values: Record<string, unknown> = {
    claudeHome, codexHome, sharedDataDirectory: storage,
    'sound.enabled': false, 'autoApprove.delayMs': 1000, ...options.values,
  };
  const state = options.state ?? new Map<string, unknown>();
  const globalState = options.globalState ?? new Map<string, unknown>();
  const installed = new Set(options.installed ?? ['anthropic.claude-code', 'openai.chatgpt']);
  const commands = new Map<string, () => unknown>();
  const callbacks = new Map<string, (event?: unknown) => void>();
  const messages: string[] = [];
  const logs: string[] = [];
  const executed: string[] = [];
  const subscriptions: { dispose: () => void }[] = [];
  const disposable = { dispose: () => {} };
  const status = { ...disposable, text: '', show: () => {} };
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file' });
  let connected: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
  const event = (key: string) => (callback: (event?: unknown) => void) => { callbacks.set(key, callback); return disposable; };
  const mock = {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 }, ThemeColor: class {},
    env: { appName: 'test', remoteName: options.remote ? 'ssh-remote' : undefined }, version: 'test',
    extensions: {
      getExtension: (id: string) => installed.has(id) ? { packageJSON: { version: 'test' } } : undefined,
      onDidChange: event('extensions'),
    },
    commands: {
      registerCommand: (name: string, callback: () => unknown) => { commands.set(name, callback); return disposable; },
      executeCommand: async (name: string) => { executed.push(name); },
    },
    workspace: {
      isTrusted: options.trusted ?? true, workspaceFolders: [{ uri: uri(directory) }],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => values[key] ?? fallback,
        update: async (key: string, value: unknown) => { values[key] = value; },
      }),
      onDidChangeConfiguration: event('settings'), onDidChangeWorkspaceFolders: event('folders'),
      onDidGrantWorkspaceTrust: event('trust'),
    },
    window: {
      createStatusBarItem: () => status,
      createOutputChannel: () => ({ ...disposable, show: () => {}, appendLine: (message: string) => {
        logs.push(message);
        if (message.includes('Local hook connection ready')) connected();
        if (message.includes('Could not open the local hook connection')) failed(new Error(message));
      } }),
      showInformationMessage: async (message: string) => { messages.push(message); },
      showWarningMessage: async (message: string) => { messages.push(message); },
      showErrorMessage: async (message: string) => { messages.push(message); },
    },
  };
  const loader = Module as unknown as { _load: (id: string, parent: NodeModule, isMain: boolean) => unknown };
  const original = loader._load;
  let extension: typeof import('../src/extension');
  try {
    loader._load = function (id, parent, isMain) { return id === 'vscode' ? mock : original.call(this, id, parent, isMain); };
    delete require.cache[require.resolve('../src/extension')];
    extension = require('../src/extension') as typeof import('../src/extension');
  } finally { loader._load = original; }
  const close = () => { for (const subscription of subscriptions.splice(0)) subscription.dispose(); };
  t.after(async () => { close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); });
  extension.activate({
    extensionUri: uri(path.resolve(__dirname, '../..')), globalStorageUri: uri(storage), subscriptions,
    workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } },
    globalState: { get: (key: string, fallback?: unknown) => globalState.get(key) ?? fallback, update: async (key: string, value: unknown) => { globalState.set(key, value); } },
    ...(options.version ? { extension: { packageJSON: { version: options.version } } } : {}),
  } as unknown as vscode.ExtensionContext);
  await ready;
  const call = async (command: string) => commands.get(`agentAlert.${command}`)?.();
  const permission = async (toolName = 'Bash', provider: 'claude' | 'codex' = 'claude') => {
    const endpoints = await discoverEndpoints(path.join(storage, 'endpoints'));
    assert.equal(endpoints.length, 1);
    return postHookEvent(endpoints[0]!, { provider, kind: 'permission', toolName, cwd: directory, requestId: String(Math.random()), sessionId: 'fixture' });
  };
  return { directory, claudeHome, codexHome, storage, values, state, globalState, installed, messages, logs, executed, status, close, call, permission, callbacks, mock };
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Automatic setup did not complete.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('fresh installation creates both hooks and auto approves; stop survives reload', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const [home, name, provider] of [[f.claudeHome, 'settings.json', 'claude'], [f.codexHome, 'hooks.json', 'codex']]) {
    const hooks = JSON.parse(await readFile(path.join(home!, name!), 'utf8'));
    assert.ok(hooks.hooks.PermissionRequest[0].hooks[0].command.includes(path.join(f.storage, 'hook-runtime', 'hook-client.js')));
    assert.ok(hooks.hooks.PermissionRequest[0].hooks[0].command.endsWith(`--agent-alert-${provider}`));
  }
  assert.match(f.status.text, /Auto armed/);
  assert.equal(await f.permission(), true);
  assert.equal(await f.permission('AskUserQuestion'), false);
  await f.call('toggleAutoApprove');
  assert.equal(f.state.get('autoApprove.stopped'), true);
  assert.equal(await f.permission(), false);
  const before = await readFile(path.join(f.claudeHome, 'settings.json'), 'utf8');
  const mtime = (await stat(path.join(f.storage, 'hook-runtime', 'hook-client.js'))).mtimeMs;
  f.close();
  const restarted = await fixture(t, { directory: f.directory, state: f.state });
  assert.match(restarted.status.text, /Alerts only/);
  assert.equal(await restarted.permission(), false);
  assert.equal(await readFile(path.join(f.claudeHome, 'settings.json'), 'utf8'), before);
  assert.equal((await stat(path.join(f.storage, 'hook-runtime', 'hook-client.js'))).mtimeMs, mtime);
  assert.equal((await readdir(f.claudeHome)).filter(name => name.includes('backup')).length, 0);
  await restarted.call('toggleAutoApprove');
  assert.equal(await restarted.permission(), true);
  await restarted.call('pause');
  assert.equal(restarted.state.get('paused'), true);
});

test('a newly installed version reloads the IDE window once without a reload loop', { timeout: 10_000 }, async t => {
  const globalState = new Map<string, unknown>();
  const first = await fixture(t, { version: '0.6.0', globalState, installed: [] });
  await eventually(async () => first.executed.includes('workbench.action.reloadWindow'));
  assert.equal(globalState.get('nod.lastActivatedVersion'), '0.6.0');
  first.close();
  const second = await fixture(t, { directory: first.directory, version: '0.6.0', globalState, installed: [] });
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(second.executed.includes('workbench.action.reloadWindow'), false);
});

test('explicit disabled approvals and empty tool lists are preserved', async t => {
  const disabled = await fixture(t, { values: { 'autoApprove.enabled': false } });
  assert.match(disabled.status.text, /Alerts only/);
  assert.equal(await disabled.permission(), false);
  assert.equal(disabled.values['autoApprove.enabled'], false);
  const empty = await fixture(t, { values: { 'autoApprove.claudeAllowedTools': [] } });
  assert.equal(await empty.permission(), false);
  assert.deepEqual(empty.values['autoApprove.claudeAllowedTools'], []);
});

test('automatic setup does not write configuration in untrusted, remote, disabled, or paused windows', async t => {
  for (const options of [
    { trusted: false }, { remote: true }, { values: { 'enabled': false } },
    { values: { 'setup.automatic': false } }, { state: new Map<string, unknown>([['paused', true]]) },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(readFile(path.join(f.claudeHome, 'settings.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(f.codexHome, 'hooks.json')), { code: 'ENOENT' });
  }
});

test('setup responds to an agent installed later and to workspace trust', async t => {
  const f = await fixture(t, { installed: [] });
  await assert.rejects(readFile(path.join(f.claudeHome, 'settings.json')), { code: 'ENOENT' });
  f.installed.add('anthropic.claude-code');
  f.callbacks.get('extensions')!();
  await eventually(async () => f.logs.some(line => line.includes('Claude Code hooks configured automatically')));
  await assert.rejects(readFile(path.join(f.codexHome, 'hooks.json')), { code: 'ENOENT' });
  const untrusted = await fixture(t, { trusted: false, installed: ['anthropic.claude-code'] });
  untrusted.mock.workspace.isTrusted = true;
  untrusted.callbacks.get('trust')!();
  await eventually(async () => untrusted.logs.some(line => line.includes('Claude Code hooks configured automatically')));
});

test('missing Node reports a setup problem without writing broken hooks', async t => {
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string) => void;
    queueMicrotask(() => callback(new Error('ENOENT'), ''));
    return {} as childProcess.ChildProcess;
  });
  const f = await fixture(t);
  assert.match(f.status.text, /Setup needed/);
  assert.ok(f.messages.some(message => message.includes('Node.js 18+')));
  await assert.rejects(readFile(path.join(f.claudeHome, 'settings.json')), { code: 'ENOENT' });
});

test('automatic setup preserves malformed configuration and reports it', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-alert-invalid-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'claude'));
  const file = path.join(directory, 'claude', 'settings.json');
  await writeFile(file, '{broken');
  const f = await fixture(t, { directory, installed: ['anthropic.claude-code'] });
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.match(f.status.text, /Setup needed/);
  assert.ok(f.messages.some(message => message.includes('Claude Code setup:')));
});

test('disabled Claude hooks remain disabled and report setup needed after reload', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-alert-disabled-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'claude'));
  const file = path.join(directory, 'claude', 'settings.json');
  await writeFile(file, JSON.stringify({ disableAllHooks: true }));
  const f = await fixture(t, { directory, installed: ['anthropic.claude-code'] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).disableAllHooks, true);
  assert.match(f.status.text, /Setup needed/);
  f.close();
  const restarted = await fixture(t, { directory, installed: ['anthropic.claude-code'] });
  assert.match(restarted.status.text, /Setup needed/);
  assert.ok(restarted.messages.some(message => message.includes('disableAllHooks')));
  const configuration = JSON.parse(await readFile(file, 'utf8'));
  configuration.disableAllHooks = false;
  await writeFile(file, JSON.stringify(configuration));
  await restarted.call('setupClaude');
  assert.match(restarted.status.text, /Auto armed/);
});
