import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createHooks, mergeHooks, quoteShellArgument } from '../src/setup';

const COMMAND = "node '/extension/hook.cjs' --registry '/config/registry' --agent-alert-codex";
const CLAUDE_COMMAND = COMMAND.replace('--agent-alert-codex', '--agent-alert-claude');

type Configuration = {
  description: string;
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
};

test('generated native hooks target approvals and user questions with bounded timeouts', () => {
  const config = createHooks(COMMAND) as unknown as Configuration;
  assert.ok(config.description.includes('Codex'));
  assert.deepEqual(config.hooks.PermissionRequest, [{
    matcher: '*',
    hooks: [{ type: 'command', command: COMMAND, timeout: 45, statusMessage: 'Nod: approval notification' }],
  }]);
  const question = config.hooks.PreToolUse![0]!;
  assert.equal(question.hooks[0]!.timeout, 5);
  assert.equal(question.hooks[0]!.statusMessage, 'Nod: question notification');
  const matcher = new RegExp(question.matcher!);
  for (const name of ['request_user_input', 'functions.request_user_input', 'functions_request_user_input_async']) {
    assert.equal(matcher.test(name), true);
  }
  for (const name of ['notrequest_user_input', 'request_user_input_extra', 'run_command']) {
    assert.equal(matcher.test(name), false);
  }
});

test('Claude settings use native regex matchers for permission and question hooks', () => {
  const config = createHooks(CLAUDE_COMMAND, 'claude') as unknown as Configuration;
  assert.equal('description' in config, false);
  const permission = config.hooks.PermissionRequest![0]!;
  assert.equal(permission.hooks[0]!.timeout, 45);
  for (const name of ['Bash', 'Edit', 'Write', 'mcp__server__tool']) {
    assert.equal(new RegExp(permission.matcher!).test(name), true);
  }
  const question = config.hooks.PreToolUse![0]!;
  assert.equal(question.hooks[0]!.timeout, 5);
  assert.equal(question.hooks[0]!.command, CLAUDE_COMMAND);
  assert.equal(new RegExp(question.matcher!).test('AskUserQuestion'), true);
  for (const name of ['AskUserQuestionExtra', 'NotAskUserQuestion', 'request_user_input', 'Bash']) {
    assert.equal(new RegExp(question.matcher!).test(name), false);
  }
});

test('Claude setup preserves permissions, plugins, environment, disabled hooks, and other agent hooks', () => {
  const existing = {
    permissions: { deny: ['Bash(rm *)'], defaultMode: 'default' },
    env: { SOME_SETTING: 'keep' }, enabledPlugins: { 'example@marketplace': true },
    disableAllHooks: true,
    hooks: {
      PermissionRequest: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: 'node old-helper --agent-alert-claude' },
        { type: 'command', command: COMMAND },
        { type: 'command', command: 'echo --agent-alert-claude-other' },
        { type: 'command', command: 'echo "--agent-alert-claude"' },
      ] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo completed' }] }],
    },
  };
  const before = JSON.stringify(existing);
  const merged = mergeHooks(existing, CLAUDE_COMMAND, 'claude') as typeof existing;
  assert.equal(JSON.stringify(existing), before);
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.deepEqual(merged.env, existing.env);
  assert.deepEqual(merged.enabledPlugins, existing.enabledPlugins);
  assert.equal(merged.disableAllHooks, true);
  assert.deepEqual(merged.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(merged.hooks.PermissionRequest[0]!.hooks, existing.hooks.PermissionRequest[0]!.hooks.slice(1));
  assert.deepEqual(mergeHooks(merged, CLAUDE_COMMAND, 'claude'), merged);
  const updated = CLAUDE_COMMAND.replace('/extension/', '/new version/');
  const upgraded = mergeHooks(merged, updated, 'claude');
  assert.deepEqual(mergeHooks(upgraded, updated, 'claude'), upgraded);
  assert.equal(JSON.stringify(upgraded).includes('node old-helper'), false);
  assert.throws(() => mergeHooks({ permissions: {}, hooks: [] }, CLAUDE_COMMAND, 'claude'));
});

test('merge preserves unrelated metadata and commands in mixed groups without mutating input', () => {
  const existing = {
    description: 'My existing hooks',
    version: 1,
    custom: { keep: true },
    hooks: {
      PermissionRequest: [{
        matcher: 'Bash', customGroupField: true,
        hooks: [
          { type: 'command', command: 'node old-helper --agent-alert-codex', timeout: 99 },
          { type: 'command', command: 'echo user-hook', timeout: 12 },
        ],
      }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo completed' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [] }],
    },
  };
  const before = JSON.stringify(existing);
  const merged = mergeHooks(existing, COMMAND) as unknown as Configuration & { version: number; custom: unknown };
  assert.equal(JSON.stringify(existing), before);
  assert.equal(merged.description, existing.description);
  assert.equal(merged.version, 1);
  assert.deepEqual(merged.custom, { keep: true });
  assert.deepEqual(merged.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(merged.hooks.SessionStart, existing.hooks.SessionStart);
  assert.deepEqual(merged.hooks.PermissionRequest![0], {
    matcher: 'Bash', customGroupField: true,
    hooks: [{ type: 'command', command: 'echo user-hook', timeout: 12 }],
  });
  assert.equal(merged.hooks.PermissionRequest!.length, 2);
});

test('merge replaces our hooks idempotently and updates obsolete helper paths', () => {
  const first = mergeHooks({}, COMMAND);
  assert.deepEqual(mergeHooks(first, COMMAND), first);
  const updatedCommand = COMMAND.replace('/extension/hook.cjs', '/updated/hook.cjs');
  const updated = mergeHooks(first, updatedCommand);
  assert.deepEqual(updated, createHooks(updatedCommand));
  assert.deepEqual(mergeHooks(updated, updatedCommand), updated);
});

test('only command hooks containing the exact marker token are removed', () => {
  const preserved = [
    { type: 'command', command: 'echo --agent-alert-codex-other' },
    { type: 'command', command: 'echo prefix--agent-alert-codex' },
    { type: 'prompt', prompt: '--agent-alert-codex' },
  ];
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [
    ...preserved, { type: 'command', command: 'node old --agent-alert-codex --extra' },
  ] }] } }, COMMAND) as unknown as Configuration;
  assert.deepEqual(merged.hooks.Stop, [{ hooks: preserved }]);
});

test('marker text in quoted or escaped arguments does not remove unrelated hooks', () => {
  const preserved = [
    'node "/tmp/ --agent-alert-codex hook.js"',
    "node '/tmp/ --agent-alert-codex hook.js'",
    'node "/tmp/ --agent-alert-codex"',
    'node /tmp/path\\ --agent-alert-codex',
    'echo "--agent-alert-codex"',
    "echo '--agent-alert-codex'",
    'node "/tmp/path "--agent-alert-codex',
  ].map((command) => ({ type: 'command', command }));
  const owned = [
    "node '/tmp/a'\"'\"'b.js' --agent-alert-codex",
    'node "C:\\Program Files\\Agent Alert\\hook.js" --agent-alert-codex --other',
  ].map((command) => ({ type: 'command', command }));
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [...preserved, ...owned] }] } }, COMMAND) as unknown as Configuration;
  assert.deepEqual(merged.hooks.Stop, [{ hooks: preserved }]);
});

test('invalid existing config is rejected instead of silently overwritten', () => {
  for (const value of [
    undefined, null, [], '', 12, new Date(),
    { hooks: null }, { hooks: [] }, { hooks: 'wrong' },
    { hooks: { Stop: {} } }, { hooks: { Stop: [null] } },
    { hooks: { Stop: [{ hooks: {} }] } }, { hooks: { Stop: [{ hooks: [null] }] } },
    { hooks: { Stop: [{ matcher: 3, hooks: [] }] } },
    { hooks: { Stop: [{ hooks: [{}] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 7 }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: '' }] }] } },
  ]) assert.throws(() => mergeHooks(value, COMMAND));
  for (const command of ['', '  ', 'node\nwrong', 'node\u0000wrong']) {
    assert.throws(() => createHooks(command));
  }
});

test('POSIX quoting preserves whitespace, quotes and shell syntax as literal data', () => {
  for (const value of ['', '/some path/hook.js', "a'b", '$(never) `never` $HOME; &|<>']) {
    const quoted = quoteShellArgument(value, 'linux');
    const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, value);
    assert.equal(result.stderr, '');
  }
  assert.equal(quoteShellArgument("a'b", 'darwin'), `'a'"'"'b'`);
});

test('Windows quoting supports normal paths and rejects shell expansion or operators', () => {
  assert.equal(quoteShellArgument('C:\\Program Files\\Agent Alert\\hook.cjs', 'win32'), '"C:\\Program Files\\Agent Alert\\hook.cjs"');
  assert.equal(quoteShellArgument('C:\\folder\\', 'win32'), '"C:\\folder\\\\"');
  assert.equal(quoteShellArgument('', 'win32'), '""');
  for (const value of ['a"b', '%PATH%', '!delayed!', 'a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)']) {
    assert.throws(() => quoteShellArgument(value, 'win32'));
  }
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const value of ['a\nb', 'a\rb', 'a\u0000b', 'a\tb']) {
      assert.throws(() => quoteShellArgument(value, platform));
    }
  }
});
