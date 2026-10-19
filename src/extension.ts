import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { ApprovalController } from './approval';
import { NotificationBridge, type HookEvent } from './bridge';
import { providerName, type AgentProvider } from './events';
import { createHooks, mergeHooks, quoteShellArgument } from './setup';
import { SoundPlayer, supportedSoundExtensions, validateSoundFile } from './sound';
import { findNode, prepareHookRuntime } from './runtime';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Nod');
  const log = (message: string): void => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  let installationReload: ReturnType<typeof setTimeout> | undefined;
  const installedVersion: unknown = context.extension?.packageJSON?.version;
  if (typeof installedVersion === 'string' && context.globalState
    && context.globalState.get<string>('nod.lastActivatedVersion') !== installedVersion) {
    try {
      await context.globalState.update('nod.lastActivatedVersion', installedVersion);
      log(`Nod ${installedVersion} installed or updated; reloading this IDE window once.`);
      installationReload = setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => {
          log('The IDE could not reload automatically. Run Developer: Reload Window once.');
        });
      }, 750);
    } catch {
      log('Could not save the installed version, so automatic reload was skipped. Run Developer: Reload Window once.');
    }
  }
  const sound = new SoundPlayer(log);
  const soundPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'alert.wav').fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('agentAlert');
  const configuredSharedDirectory = config().get<string>('sharedDataDirectory', '').trim();
  const sharedDirectory = configuredSharedDirectory && isAbsolute(configuredSharedDirectory)
    ? configuredSharedDirectory : join(homedir(), '.agent-alert');
  const registry = join(sharedDirectory, 'endpoints');
  const registration = join(registry, `${randomUUID()}.json`);
  let roots: string[] = [];
  let endpoint: { url: string; token: string } | undefined;
  let armed = config().get<boolean>('autoApprove.armOnStartup', true)
    && !context.workspaceState.get<boolean>('autoApprove.stopped', false);
  let paused = context.workspaceState.get<boolean>('paused', false);
  let disposed = false;
  let lastSound = 0;
  let lastEvent: string | undefined;
  const lastEvents = new Map<AgentProvider, string>();
  let publication = Promise.resolve();
  let installation = Promise.resolve();
  let automaticSetup = Promise.resolve();
  let runtime: Promise<{ node: string; helper: string }> | undefined;
  let lastRegistryPrune = 0;
  const setupProblems = new Map<AgentProvider, string>();

  if (configuredSharedDirectory && !isAbsolute(configuredSharedDirectory)) {
    setupProblems.set('codex', 'Shared data directory is not absolute; using ~/.agent-alert.');
  }

  const enabled = (): boolean => !disposed && !paused && !vscode.env.remoteName && vscode.workspace.isTrusted &&
    roots.length > 0 && config().get<boolean>('enabled', true);
  const autoEnabled = (): boolean => enabled() && armed && config().get<boolean>('autoApprove.enabled', true);

  function updateStatus(): void {
    status.text = !endpoint ? '$(bell-slash) Nod: Disconnected'
      : !enabled() ? '$(bell-slash) Nod: Paused'
      : setupProblems.size ? '$(warning) Nod: Setup needed'
      : autoEnabled() ? '$(bell) Nod: Auto armed' : '$(bell) Nod: Alerts only';
    status.backgroundColor = autoEnabled() ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = `Codex / Claude Code chat hooks · ${roots.length} local workspace folder(s)\n${lastEvent ?? 'Waiting for the first hook event.'}\n${[...setupProblems.values()].join('\n')}\nClick for controls.`;
    status.command = 'agentAlert.menu';
    status.show();
  }

  async function stopAuto(): Promise<void> {
    armed = false;
    controller.cancelAll();
    updateStatus();
    await context.workspaceState.update('autoApprove.stopped', true);
  }

  async function playAlertSound(): Promise<boolean> {
    const custom = config().get<string>('sound.file', '');
    if (!custom) return sound.play(soundPath);
    try {
      await validateSoundFile(custom);
    } catch (error) {
      log(`${error instanceof Error ? error.message : 'Custom sound is unavailable.'} Using the built-in sound.`);
      return sound.play(soundPath);
    }
    return sound.play(custom, soundPath);
  }

  function notify(event: HookEvent, automatic: boolean): void {
    const agent = providerName(event.provider);
    const simulated = event.sessionId === 'agent-alert-test';
    const received = `${agent}: ${event.kind === 'permission' ? 'Approval' : 'Question'} received at ${new Date().toLocaleTimeString()}`;
    if (!simulated) { lastEvent = received; lastEvents.set(event.provider, received); }
    log(`${simulated ? 'Test notification' : agent + ' ' + event.kind + ' hook'} (${event.toolName})${automatic ? ': automatic approval scheduled' : ': attention required'}.`);
    if (config().get<boolean>('sound.enabled', true) && Date.now() - lastSound > 1200) {
      lastSound = Date.now();
      void playAlertSound();
    }
    updateStatus();
    if (!config().get<boolean>('notifications.enabled', true)) return;
    const message = simulated ? `Test notification for ${agent}. Use a real chat question to verify the hooks.`
      : event.kind === 'question' ? `${agent} is asking you a question. Open the chat to choose an answer.`
      : automatic ? `${agent} requested ${event.toolName}. Auto approve in ${config().get<number>('autoApprove.delayMs', 3000) / 1000}s.`
      : `${agent} needs your approval to use ${event.toolName}.`;
    const openLabel = `Open ${agent}`;
    const actions = automatic ? [openLabel, 'Stop Auto Approve'] : [openLabel];
    void vscode.window.showInformationMessage(`Nod · ${message}`, ...actions).then((action) => {
      if (action === 'Stop Auto Approve') void stopAuto().catch(() => log('Auto Approve stopped, but its stopped state could not be saved.'));
      if (action === openLabel) {
        void openChat(event.provider).catch(() => log(`Could not open ${agent}. Use its sidebar button.`));
      }
    });
  }

  const controller = new ApprovalController({
    settings: () => ({
      enabled: enabled(), armed: autoEnabled(),
      allowedTools: config().get<string[]>('autoApprove.allowedTools', ['Bash', 'exec_command', 'apply_patch']),
      claudeAllowedTools: config().get<string[]>('autoApprove.claudeAllowedTools', ['Bash', 'Edit', 'Write']),
      delayMs: config().get<number>('autoApprove.delayMs', 3000),
    }),
    notify,
    approved: (event) => log(`${providerName(event.provider)}: returned an allow decision for ${event.toolName}. Other policies and hooks still apply.`),
  });

  const bridge = new NotificationBridge(async (event, signal) => {
    // Independently recheck workspace scope; the hook client's routing is not authority.
    const cwd = await fs.realpath(event.cwd).catch(() => undefined);
    const inWorkspace = cwd !== undefined && roots.some((root) => {
      const child = relative(root, cwd);
      return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    });
    if (!inWorkspace || !enabled()) return { allow: false };
    return controller.handle(event, signal);
  }, log);

  async function publish(): Promise<void> {
    if (disposed || !endpoint) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    const resolved = await Promise.all(folders.map((folder) => fs.realpath(folder.uri.fsPath).catch(() => undefined)));
    roots = resolved.filter((root): root is string => root !== undefined);
    if (disposed) return;
    await fs.mkdir(registry, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(registry, 0o700);
    if (Date.now() - lastRegistryPrune > 60 * 60_000) {
      lastRegistryPrune = Date.now();
      const cutoff = lastRegistryPrune - 24 * 60 * 60_000;
      const entries = await fs.readdir(registry, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/iu.test(entry.name)) return;
        const file = join(registry, entry.name);
        const metadata = await fs.lstat(file).catch(() => undefined);
        if (metadata?.isFile() && !metadata.isSymbolicLink() && metadata.mtimeMs < cutoff) {
          await fs.unlink(file).catch(() => undefined);
        }
      }));
    }
    const temporary = `${registration}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ ...endpoint, providers: ['codex', 'claude'], workspaces: enabled() ? roots : [], createdAt: Date.now() }), { mode: 0o600 });
    await fs.rename(temporary, registration);
    updateStatus();
  }

  function schedulePublish(): Promise<void> {
    publication = publication.then(publish).catch(() => {
      log('Could not publish the local hook connection. Check Nod storage permissions.');
    });
    return publication;
  }

  void bridge.start().then(async (address) => {
    if (disposed) return;
    endpoint = address;
    await schedulePublish();
    await scheduleAutomaticSetup();
    log('Local hook connection ready for Codex and Claude Code.');
  }).catch(() => {
    log('Could not open the local hook connection. No automatic approvals will be issued.');
    updateStatus();
  });

  const heartbeat = setInterval(() => { void schedulePublish(); }, 15_000);
  heartbeat.unref();

  async function hookCommand(provider: AgentProvider): Promise<string> {
    runtime ??= (async () => ({ node: await findNode(), helper: await prepareHookRuntime(context.extensionUri.fsPath, sharedDirectory) }))();
    let prepared: { node: string; helper: string };
    try { prepared = await runtime; } catch (error) { runtime = undefined; throw error; }
    return `${quoteShellArgument(prepared.node, process.platform)} ${quoteShellArgument(prepared.helper, process.platform)} --registry ${quoteShellArgument(registry, process.platform)} --agent-alert-${provider}`;
  }

  function scheduleAutomaticSetup(): Promise<void> {
    automaticSetup = automaticSetup.then(async () => {
      if (!enabled() || !endpoint || !config().get<boolean>('setup.automatic', true)) return;
      for (const provider of ['codex', 'claude'] as const) {
        if (!enabled() || !config().get<boolean>('setup.automatic', true)) return;
        if (!vscode.extensions.getExtension(provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt')) continue;
        try { await setupHooks(provider, true); }
        catch (error) {
          const message = `${providerName(provider)} setup: ${error instanceof Error ? error.message : 'Unexpected error.'}`;
          if (setupProblems.get(provider) !== message) void vscode.window.showWarningMessage(`Nod: ${message}`);
          setupProblems.set(provider, message);
          log(message);
        }
      }
      updateStatus();
    }).catch(() => log('Automatic hook setup failed. Run Set Up Chat Hooks from Nod.'));
    return automaticSetup;
  }

  function configHome(provider: AgentProvider): string {
    const key = provider === 'claude' ? 'claudeHome' : 'codexHome';
    const directory = config().get<string>(key, '').trim()
      || (provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME)
      || join(homedir(), provider === 'claude' ? '.claude' : '.codex');
    if (!isAbsolute(directory)) throw new Error(`agentAlert.${key} must be an absolute path.`);
    return directory;
  }

  async function openChat(provider: AgentProvider): Promise<void> {
    const agent = providerName(provider);
    const id = provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt';
    const extension = vscode.extensions.getExtension(id);
    if (!extension) {
      void vscode.window.showInformationMessage(`Install the ${agent} extension (${id}) in this IDE first.`);
      return;
    }
    await extension.activate();
    const available = await vscode.commands.getCommands(true);
    const candidates = provider === 'claude' ? ['claude-vscode.sidebar.open', 'claude-vscode.editor.open'] : ['chatgpt.openSidebar'];
    const command = candidates.find((candidate) => available.includes(candidate));
    if (command) await vscode.commands.executeCommand(command);
    else void vscode.window.showInformationMessage(`Use the ${agent} sidebar button to open your chat.`);
  }

  async function previewHooks(provider: AgentProvider): Promise<void> {
    const file = join(configHome(provider), provider === 'claude' ? 'settings.json' : 'hooks.json');
    const guidance = provider === 'claude'
      ? 'Merge into Claude Code settings without replacing other settings. Restart the Claude Code session after setup.'
      : 'Review and trust new hooks in Codex; restart Codex after setup.';
    const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content:
      `// Merge into ${file}\n// Requires Node.js 18+ and native hooks in ${providerName(provider)}.\n// ${guidance}\n// Questions notify only. Auto approval applies only to tool permissions.\n${JSON.stringify(createHooks(await hookCommand(provider), provider), null, 2)}\n` });
    await vscode.window.showTextDocument(document);
  }

  function setupHooks(provider: AgentProvider, automatic = false): Promise<void> {
    const pending = installation.then(() => installHooks(provider, automatic));
    installation = pending.catch(() => undefined);
    return pending;
  }

  async function installHooks(provider: AgentProvider, automatic: boolean): Promise<void> {
    if (!endpoint || !enabled()) {
      if (automatic) return;
      void vscode.window.showInformationMessage('Open a local project folder and wait for Nod to connect, then run setup again. Remote workspaces are not supported in this version.');
      return;
    }
    try {
      const agent = providerName(provider);
      const directory = configHome(provider);
      const filename = provider === 'claude' ? 'settings.json' : 'hooks.json';
      const file = join(directory, filename);
      const metadata = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
        throw new Error(`${filename} is not a regular file. Use Preview ${agent} Hook Configuration and merge it manually.`);
      }
      if (metadata && metadata.size > 1024 * 1024) throw new Error(`${filename} is too large to merge automatically. Use Preview ${agent} Hook Configuration.`);
      const existing = metadata ? await fs.readFile(file, 'utf8') : undefined;
      const mergedConfig = mergeHooks(existing !== undefined ? JSON.parse(existing) : {}, await hookCommand(provider), provider);
      if (automatic && (!enabled() || !config().get<boolean>('setup.automatic', true))) return;
      const merged = `${JSON.stringify(mergedConfig, null, 2)}\n`;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (existing !== undefined && existing !== merged) {
        await fs.copyFile(file, `${file}.agent-alert-backup-${Date.now()}.json`, constants.COPYFILE_EXCL);
      }
      const current = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (current !== existing && current !== merged) throw new Error(`${filename} changed during setup. Run setup again to merge the latest changes.`);
      if (current !== merged) {
        const temporary = `${file}.agent-alert-${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, merged, { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      }
      if (provider === 'claude' && mergedConfig.disableAllHooks === true) {
        const message = 'Claude Code settings have disableAllHooks enabled. The hooks were saved but will not run until you enable hooks in Claude Code.';
        if (setupProblems.get(provider) !== message) void vscode.window.showWarningMessage(`Nod: ${message}`);
        setupProblems.set(provider, message);
      } else {
        setupProblems.delete(provider);
      }
      updateStatus();
      if (automatic && current === merged) return;
      log(`${agent} hooks configured${automatic ? ' automatically' : ''}. Existing settings and hooks preserved; a backup was made if the file changed.`);
      const instruction = provider === 'claude'
        ? 'If Claude Code is already running, start a new session to load the hooks.'
        : 'Restart Codex and review/trust the new hooks (use /hooks in the Codex CLI if needed). Auto Approve is controlled separately.';
      void vscode.window.showInformationMessage(
        `${agent} hooks configured. ${instruction} Auto Approve: ${autoEnabled() ? 'armed for configured tools' : 'off'}.`,
        'Open Hook File', 'Hook Documentation',
      ).then(async (action) => {
        if (action === 'Open Hook File') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
        if (action === 'Hook Documentation') await vscode.env.openExternal(vscode.Uri.parse(provider === 'claude'
          ? 'https://code.claude.com/docs/en/hooks' : 'https://learn.chatgpt.com/docs/hooks'));
      }).then(undefined, () => log(`Could not open the hook file or documentation. Use Preview ${agent} Hook Configuration.`));
    } finally { updateStatus(); }
  }

  function register(name: string, callback: () => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(`agentAlert.${name}`, async () => {
      try { return await callback(); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error.';
        log(message);
        void vscode.window.showErrorMessage(`Nod: ${message}`);
      }
    }));
  }

  register('setupCodex', () => setupHooks('codex'));
  register('setupClaude', () => setupHooks('claude'));
  register('previewHooks', () => previewHooks('codex'));
  register('previewClaudeHooks', () => previewHooks('claude'));
  register('openCodex', () => openChat('codex'));
  register('openClaude', () => openChat('claude'));
  register('toggleAutoApprove', async () => {
    if (autoEnabled()) { await stopAuto(); log('Auto Approve stopped for this workspace; pending decisions cancelled.'); return; }
    if (!endpoint || !enabled()) {
      void vscode.window.showInformationMessage('Resume Nod in a trusted local project before arming Auto Approve.');
      return;
    }
    const codexTools = config().get<string[]>('autoApprove.allowedTools', ['Bash', 'exec_command', 'apply_patch']);
    const claudeTools = config().get<string[]>('autoApprove.claudeAllowedTools', ['Bash', 'Edit', 'Write']);
    if (codexTools.length === 0 && claudeTools.length === 0) {
      void vscode.window.showInformationMessage('Choose tools in agentAlert.autoApprove.allowedTools (Codex) or agentAlert.autoApprove.claudeAllowedTools (Claude Code) first.');
      return;
    }
    if (!config().get<boolean>('autoApprove.enabled', true)) await config().update('autoApprove.enabled', true, vscode.ConfigurationTarget.Global);
    await context.workspaceState.update('autoApprove.stopped', false);
    if (disposed || !enabled()) return;
    armed = true;
    updateStatus();
    const scope = `Codex: ${codexTools.join(', ') || 'none'}; Claude Code: ${claudeTools.join(', ') || 'none'}`;
    log(`Auto Approve armed for tool permission requests from this window. ${scope}.`);
    void vscode.window.showInformationMessage(`Auto Approve armed. ${scope}. Click Nod to stop it. Question choices still need your answer.`);
  });
  register('pause', async () => {
    paused = !paused;
    controller.cancelAll();
    await context.workspaceState.update('paused', paused);
    await schedulePublish();
    await scheduleAutomaticSetup();
    updateStatus();
  });
  register('testSound', async () => {
    if (!(await playAlertSound())) void vscode.window.showWarningMessage('Could not finish playing sound. Check Nod: Show Log.');
  });
  register('chooseSound', async () => {
    const current = config().get<string>('sound.file', '');
    const selected = await vscode.window.showOpenDialog({
      title: 'Choose a Nod alert sound', openLabel: 'Use this sound',
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { Audio: supportedSoundExtensions() },
      defaultUri: current && isAbsolute(current) ? vscode.Uri.file(current) : undefined,
    });
    const file = selected?.[0];
    if (!file) return;
    if (file.scheme !== 'file') throw new Error('Choose a sound file on this computer.');
    await validateSoundFile(file.fsPath);
    await config().update('sound.file', file.fsPath, vscode.ConfigurationTarget.Global);
    log(`Selected alert sound: ${basename(file.fsPath)}.`);
    // Preview the chosen file itself, so a failed preview is not mistaken for success.
    if (!(await sound.play(file.fsPath))) {
      void vscode.window.showWarningMessage('Sound saved, but the preview did not finish. Playback is limited to 5 seconds. Try Test Sound or choose another file.');
      return;
    }
    void vscode.window.showInformationMessage(`Alert sound: ${basename(file.fsPath)}.${config().get<boolean>('sound.enabled', true) ? '' : ' Enable agentAlert.sound.enabled to hear it on notifications.'}`);
  });
  register('resetSound', async () => {
    await config().update('sound.file', '', vscode.ConfigurationTarget.Global);
    if (!(await playAlertSound())) void vscode.window.showWarningMessage('Built-in sound restored, but the preview could not finish. Check Nod: Show Log.');
    else void vscode.window.showInformationMessage('Built-in alert sound restored.');
  });
  const testNotification = (provider: AgentProvider): void => notify({ provider, kind: 'question', cwd: roots[0] ?? '',
    toolName: provider === 'claude' ? 'AskUserQuestion' : 'request_user_input', sessionId: 'agent-alert-test', requestId: randomUUID() }, false);
  register('testNotification', () => testNotification('codex'));
  register('testClaudeNotification', () => testNotification('claude'));
  register('showLog', () => output.show());
  register('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Pimmawat.agent-alert'));
  register('diagnostics', () => {
    log(`IDE: ${vscode.env.appName} ${vscode.version}`);
    for (const provider of ['codex', 'claude'] as const) {
      const extension = vscode.extensions.getExtension(provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt');
      log(`${providerName(provider)}: ${extension ? extension.packageJSON.version : 'not installed'}`);
      log(`Hook configuration: ${join(configHome(provider), provider === 'claude' ? 'settings.json' : 'hooks.json')}.`);
      log(lastEvents.get(provider) ?? `No real ${providerName(provider)} hook event received yet. Set up hooks and trigger a supported local tool event.`);
    }
    log(`Connection: ${endpoint ? 'listening on local loopback' : 'disconnected'}; local workspace folders: ${roots.length}.`);
    log(`Shared multi-IDE registry: ${registry}.`);
    log(`Auto Approve: ${autoEnabled() ? 'armed' : 'off'}.`);
    log(`Automatic setup: ${config().get<boolean>('setup.automatic', true) ? 'on' : 'off'}; start armed: ${config().get<boolean>('autoApprove.armOnStartup', true)}; stopped in workspace: ${context.workspaceState.get<boolean>('autoApprove.stopped', false)}.`);
    for (const message of setupProblems.values()) log(message);
    log(`Sound: ${config().get<boolean>('sound.enabled', true) ? 'enabled' : 'disabled'}; file: ${config().get<string>('sound.file', '') || 'built-in'}.`);
    output.show();
  });
  register('menu', async () => {
    const items = [
      { label: '$(plug) Set up Codex chat hooks', command: 'setupCodex' },
      { label: '$(plug) Set up Claude Code chat hooks', command: 'setupClaude' },
      { label: '$(file-code) Preview Codex hook configuration', command: 'previewHooks' },
      { label: '$(file-code) Preview Claude Code hook configuration', command: 'previewClaudeHooks' },
      { label: `$(check) ${autoEnabled() ? 'Stop' : 'Arm'} Auto Approve in this window`, command: 'toggleAutoApprove' },
      { label: `$(debug-pause) ${paused ? 'Resume' : 'Pause'} Nod`, command: 'pause' },
      { label: '$(comment-discussion) Open Codex chat', command: 'openCodex' },
      { label: '$(comment-discussion) Open Claude Code chat', command: 'openClaude' },
      { label: '$(folder-opened) Choose alert sound…', command: 'chooseSound' },
      { label: '$(discard) Restore built-in sound', command: 'resetSound' },
      { label: '$(unmute) Test sound', command: 'testSound' },
      { label: '$(bell) Test Codex chat notification', command: 'testNotification' },
      { label: '$(bell) Test Claude Code chat notification', command: 'testClaudeNotification' },
      { label: '$(settings-gear) Settings', command: 'openSettings' },
      { label: '$(info) Connection status', command: 'diagnostics' },
    ];
    const item = await vscode.window.showQuickPick(items, { title: 'Nod · Codex / Claude Code' });
    if (item) await vscode.commands.executeCommand(`agentAlert.${item.command}`);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { controller.cancelAll(); void schedulePublish().then(scheduleAutomaticSetup); }),
    vscode.extensions.onDidChange(() => { void scheduleAutomaticSetup(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void schedulePublish().then(scheduleAutomaticSetup); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('agentAlert')) return;
      controller.cancelAll();
      if (event.affectsConfiguration('agentAlert.autoApprove.enabled') || event.affectsConfiguration('agentAlert.autoApprove.armOnStartup')) {
        armed = config().get<boolean>('autoApprove.enabled', true) && config().get<boolean>('autoApprove.armOnStartup', true)
          && !context.workspaceState.get<boolean>('autoApprove.stopped', false);
      }
      void schedulePublish().then(scheduleAutomaticSetup);
      updateStatus();
    }),
    { dispose: () => {
      disposed = true;
      if (installationReload) clearTimeout(installationReload);
      clearInterval(heartbeat);
      controller.dispose();
      bridge.dispose();
      sound.dispose();
      void publication.finally(async () => {
        await fs.unlink(registration).catch(() => undefined);
        await fs.unlink(`${registration}.tmp`).catch(() => undefined);
      });
    } },
    status, output,
  );
  updateStatus();
}
