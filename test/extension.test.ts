import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { discoverEndpoints, postHookEvent } from '../src/hook-client';
import { SoundPlayer } from '../src/sound';

test('extension sets up each agent in fixture files and routes Claude notifications to its chat', { timeout: 10_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-alert-extension-')));
  const claudeHome = path.join(directory, 'claude');
  const codexHome = path.join(directory, 'codex');
  const settingsFile = path.join(claudeHome, 'settings.json');
  const storage = path.join(directory, 'storage');
  const values: Record<string, unknown> = {
    claudeHome, codexHome, sharedDataDirectory: storage, 'sound.enabled': false,
    'autoApprove.allowedTools': ['Bash'], 'autoApprove.claudeAllowedTools': [],
    'setup.automatic': false, 'autoApprove.armOnStartup': false,
  };
  const original = JSON.stringify({
    permissions: { deny: ['Bash(rm *)'] }, enabledPlugins: { 'test@local': true },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  });
  await mkdir(claudeHome);
  await writeFile(settingsFile, original);
  const logs: string[] = [];
  const errors: string[] = [];
  const messages: string[] = [];
  const executed: string[] = [];
  const documents: { content: string }[] = [];
  const commands = new Map<string, () => unknown>();
  const subscriptions: { dispose: () => void }[] = [];
  let chosenFiles: { fsPath: string; scheme: string }[] | undefined;
  const dialogs: vscode.OpenDialogOptions[] = [];
  const sounds: { file: string; fallback?: string }[] = [];
  let onSound: (() => void) | undefined;
  t.mock.method(SoundPlayer.prototype, 'play', async (file: string, fallback?: string) => {
    sounds.push({ file, fallback });
    onSound?.();
    return true;
  });
  let selection: string | undefined;
  let connected: () => void = () => {};
  let connectionFailed: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { connected = resolve; connectionFailed = reject; });
  const disposable = { dispose: () => {} };
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file' });
  const execute = async (command: string): Promise<unknown> => {
    executed.push(command);
    return commands.get(command)?.();
  };
  const mock = {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
    ThemeColor: class {},
    version: 'test', env: { appName: 'fixture IDE' },
    extensions: { getExtension: () => ({ packageJSON: { version: 'fixture' }, activate: async () => {} }), onDidChange: () => disposable },
    commands: {
      registerCommand: (command: string, callback: () => unknown) => { commands.set(command, callback); return disposable; },
      executeCommand: execute,
      getCommands: async () => ['claude-vscode.sidebar.open', 'chatgpt.openSidebar'],
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(directory) }],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => values[key] ?? fallback,
        update: async (key: string, value: unknown) => { values[key] = value; },
      }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
      openTextDocument: async (document: { content: string }) => { documents.push(document); return document; },
    },
    window: {
      createStatusBarItem: () => ({ ...disposable, show: () => {} }),
      createOutputChannel: () => ({ ...disposable, show: () => {}, appendLine: (message: string) => {
        logs.push(message);
        if (message.includes('Local hook connection ready')) connected();
        if (message.includes('Could not open the local hook connection')) connectionFailed(new Error(message));
      } }),
      showInformationMessage: async (message: string) => { messages.push(message); const action = selection; selection = undefined; return action; },
      showWarningMessage: async (message: string) => { messages.push(message); },
      showErrorMessage: async (message: string) => { errors.push(message); },
      showTextDocument: async () => {},
      showOpenDialog: async (options: vscode.OpenDialogOptions) => { dialogs.push(options); return chosenFiles; },
    },
  };
  // The UI is mocked; setup uses real temporary files and notifications use the real bridge.
  const loader = Module as unknown as { _load: (id: string, parent: NodeModule, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  let extension: typeof import('../src/extension');
  try {
    loader._load = function (id, parent, isMain) {
      return id === 'vscode' ? mock : originalLoad.call(this, id, parent, isMain);
    };
    extension = require('../src/extension') as typeof import('../src/extension');
  } finally { loader._load = originalLoad; }
  t.after(async () => {
    for (const subscription of subscriptions) subscription.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  extension.activate({
    extensionUri: uri(path.resolve(__dirname, '../..')), globalStorageUri: uri(storage), subscriptions,
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} },
  } as unknown as vscode.ExtensionContext);
  await ready;

  await execute('agentAlert.previewClaudeHooks');
  assert.match(documents[0]!.content, /--agent-alert-claude/);
  assert.equal(await readFile(settingsFile, 'utf8'), original);
  await execute('agentAlert.setupClaude');
  assert.deepEqual(errors, []);
  const installed = await readFile(settingsFile, 'utf8');
  const parsed = JSON.parse(installed);
  assert.deepEqual(parsed.permissions, JSON.parse(original).permissions);
  assert.deepEqual(parsed.enabledPlugins, JSON.parse(original).enabledPlugins);
  assert.deepEqual(parsed.hooks.Stop, JSON.parse(original).hooks.Stop);
  assert.match(parsed.hooks.PermissionRequest[0].hooks[0].command, /--agent-alert-claude$/);
  const backups = (await readdir(claudeHome)).filter((name) => name.includes('backup'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(claudeHome, backups[0]!), 'utf8'), original);
  await execute('agentAlert.setupClaude');
  assert.equal(await readFile(settingsFile, 'utf8'), installed);
  assert.equal((await readdir(claudeHome)).filter((name) => name.includes('backup')).length, 1);
  await execute('agentAlert.setupCodex');
  assert.match(await readFile(path.join(codexHome, 'hooks.json'), 'utf8'), /--agent-alert-codex/);
  assert.equal(await readFile(settingsFile, 'utf8'), installed);

  const endpoints = await discoverEndpoints(path.join(storage, 'endpoints'));
  assert.equal(endpoints.length, 1);
  assert.deepEqual(endpoints[0]!.providers, ['codex', 'claude']);
  await execute('agentAlert.testClaudeNotification');
  await execute('agentAlert.diagnostics');
  assert.ok(logs.some((line) => line.includes('No real Claude Code hook event received yet')));
  assert.ok(messages.some((line) => line.includes('Test notification for Claude Code')));

  selection = 'Open Claude Code';
  const question = { provider: 'claude' as const, kind: 'question' as const, sessionId: 's1', requestId: 'q1', cwd: directory, toolName: 'AskUserQuestion' };
  assert.equal(await postHookEvent(endpoints[0]!, question), false);
  assert.ok(executed.includes('claude-vscode.sidebar.open'));
  assert.equal(executed.includes('chatgpt.openSidebar'), false);
  assert.ok(messages.some((line) => line.includes('Claude Code is asking you a question')));
  logs.length = 0;
  await execute('agentAlert.diagnostics');
  assert.ok(logs.some((line) => line.includes('Claude Code: Question received')));
  assert.ok(logs.some((line) => line.includes('No real Codex hook event received yet')));

  await execute('agentAlert.toggleAutoApprove');
  assert.ok(messages.some((line) => line.includes('Codex: Bash; Claude Code: none')));
  assert.equal(await postHookEvent(endpoints[0]!, { ...question, kind: 'permission', toolName: 'Bash', requestId: 'p1' }), false);
  assert.ok(messages.some((line) => line.includes('Claude Code needs your approval to use Bash')));

  await writeFile(settingsFile, '{invalid json');
  await execute('agentAlert.setupClaude');
  assert.equal(errors.length, 1);
  assert.equal(await readFile(settingsFile, 'utf8'), '{invalid json');

  const custom = path.join(directory, "my custom alert's.wav");
  const bundled = path.resolve(__dirname, '../../assets/alert.wav');
  await writeFile(custom, await readFile(bundled));
  chosenFiles = [uri(custom)];
  await execute('agentAlert.chooseSound');
  assert.equal(values['sound.file'], custom);
  assert.deepEqual(sounds.at(-1), { file: custom, fallback: undefined });
  assert.equal(dialogs[0]!.canSelectMany, false);
  assert.equal(dialogs[0]!.canSelectFolders, false);
  const previews = sounds.length;
  chosenFiles = undefined;
  await execute('agentAlert.chooseSound');
  assert.equal(values['sound.file'], custom);
  assert.equal(sounds.length, previews);
  assert.equal(dialogs[1]!.defaultUri!.fsPath, custom);

  const previousErrors = errors.length;
  for (const file of [uri(path.join(directory, 'missing.wav')), { ...uri(custom), scheme: 'https' }]) {
    chosenFiles = [file];
    await execute('agentAlert.chooseSound');
    assert.equal(values['sound.file'], custom);
  }
  assert.equal(errors.length, previousErrors + 2);
  assert.equal(sounds.length, previews);

  values['sound.enabled'] = true;
  const heard = new Promise<void>(resolve => { onSound = resolve; });
  await postHookEvent(endpoints[0]!, { ...question, requestId: 'custom-sound' });
  await heard;
  onSound = undefined;
  assert.deepEqual(sounds.at(-1), { file: custom, fallback: bundled });
  await execute('agentAlert.testSound');
  assert.deepEqual(sounds.at(-1), { file: custom, fallback: bundled });

  await rm(custom);
  await execute('agentAlert.testSound');
  assert.equal(sounds.at(-1)!.file, bundled);
  assert.ok(logs.some(message => message.includes('Using the built-in sound')));
  await execute('agentAlert.resetSound');
  assert.equal(values['sound.file'], '');
  assert.equal(sounds.at(-1)!.file, bundled);
});
