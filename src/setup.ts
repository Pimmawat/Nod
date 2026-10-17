import type { AgentProvider } from './events';

type JsonObject = Record<string, unknown>;

const DESCRIPTION = 'Native Codex chat notifications and optional approval replies for Nod.';

function hasOwnCommandMarker(command: string, marker: string): boolean {
  let quote: "'" | '"' | undefined;
  let token = '';
  let plain = true;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === '\\') index++;
      continue;
    }
    if (/\s/u.test(character)) {
      if (plain && token === marker) return true;
      token = '';
      plain = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      plain = false;
    } else if (character === '\\') {
      // An escaped space is part of its argument, not a token boundary.
      plain = false;
      index++;
    } else if (token.length <= marker.length) {
      token += character;
    }
  }
  return plain && token === marker;
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateCommand(command: string): void {
  if (typeof command !== 'string' || !command.trim() || /[\u0000-\u001f\u007f]/u.test(command)) {
    throw new Error('The Nod hook command must be a nonempty single-line string.');
  }
}

/** Configuration only: callers decide where and when to write these hooks. */
export function createHooks(command: string, provider: AgentProvider = 'codex'): JsonObject {
  validateCommand(command);
  return {
    ...(provider === 'codex' ? { description: DESCRIPTION } : {}),
    hooks: {
      PermissionRequest: [{
        matcher: provider === 'claude' ? '.*' : '*',
        hooks: [{
          type: 'command',
          command,
          timeout: 45,
          statusMessage: 'Nod: approval notification',
        }],
      }],
      PreToolUse: [{
        matcher: provider === 'claude' ? '^AskUserQuestion$' : '(^|[._])request_user_input(_async)?$',
        hooks: [{
          type: 'command',
          command,
          timeout: 5,
          statusMessage: 'Nod: question notification',
        }],
      }],
    },
  };
}

function validateGroup(value: unknown, event: string): asserts value is JsonObject & { hooks: JsonObject[] } {
  if (!isObject(value) || !Array.isArray(value.hooks)) {
    throw new Error(`Invalid ${event} hook group: expected an object with a hooks array.`);
  }
  if ('matcher' in value && typeof value.matcher !== 'string') {
    throw new Error(`Invalid ${event} hook group: matcher must be a string.`);
  }
  for (const hook of value.hooks) {
    if (!isObject(hook) || typeof hook.type !== 'string' || !hook.type.trim()) {
      throw new Error(`Invalid ${event} hook: expected an object with a type string.`);
    }
    if ((hook.type === 'command' && typeof hook.command !== 'string')
      || ('command' in hook && typeof hook.command !== 'string')) {
      throw new Error(`Invalid ${event} hook: command must be a string.`);
    }
    if (hook.type === 'command' && !(hook.command as string).trim()) {
      throw new Error(`Invalid ${event} hook: command must not be empty.`);
    }
  }
}

/** Preserve user configuration and replace only explicitly marked command hooks. */
export function mergeHooks(existing: unknown, command: string, provider: AgentProvider = 'codex'): JsonObject {
  const generated = createHooks(command, provider);
  if (!isObject(existing)) throw new Error('The existing hook configuration must be a JSON object.');
  if ('hooks' in existing && !isObject(existing.hooks)) {
    throw new Error('The existing hooks property must be a JSON object.');
  }
  const oldHooks = (existing.hooks ?? {}) as JsonObject;
  const mergedHooks: JsonObject = { ...oldHooks };
  for (const [event, groups] of Object.entries(oldHooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks: expected an array of groups.`);
    const retainedGroups: JsonObject[] = [];
    for (const group of groups) {
      validateGroup(group, event);
      const retainedHooks = group.hooks.filter((hook) => !(
        hook.type === 'command' && typeof hook.command === 'string' && hasOwnCommandMarker(hook.command, `--agent-alert-${provider}`)
      ));
      // Keep preexisting empty groups; discard a group only when it contained
      // exclusively our commands, whose replacements are appended below.
      if (retainedHooks.length > 0 || group.hooks.length === 0) {
        retainedGroups.push({ ...group, hooks: retainedHooks });
      }
    }
    mergedHooks[event] = retainedGroups;
  }
  for (const [event, groups] of Object.entries(generated.hooks as JsonObject)) {
    mergedHooks[event] = [...(mergedHooks[event] as unknown[] | undefined ?? []), ...(groups as unknown[])];
  }
  return {
    ...(provider === 'codex' ? { description: DESCRIPTION } : {}),
    ...existing,
    hooks: mergedHooks,
  };
}

/** Quote one command argument for the shell used by native command hooks. */
export function quoteShellArgument(value: string, platform: NodeJS.Platform): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Shell arguments cannot contain control characters.');
  }
  if (platform === 'win32') {
    // Windows hook runners can involve cmd.exe. Reject expansion and control
    // syntax instead of relying on quoting that changes across shell layers.
    if (/["%!&|<>^()]/u.test(value)) {
      throw new Error('This Windows path contains characters that cannot be safely used in a hook command.');
    }
    // Windows argument parsers treat backslashes directly before a closing
    // quote specially, so double only a trailing run of backslashes.
    return `"${value.replace(/\\+$/u, (slashes) => slashes + slashes)}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
