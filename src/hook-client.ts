import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { isProvider, isQuestionTool, isToolPermission, type AgentProvider, type HookEvent } from './events';
export type { HookEvent } from './events';

export interface RegistryEndpoint {
  url: string;
  token: string;
  workspaces: string[];
  createdAt: number;
  providers?: AgentProvider[];
}

export const MAX_INPUT_BYTES = 1024 * 1024;
// A longer freshness window survives laptop sleep and short event-loop stalls.
// Dead endpoints are harmless because the client falls through to another
// matching IDE instance when the loopback connection cannot be reached.
export const MAX_ENDPOINT_AGE_MS = 5 * 60_000;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024;
const OVERALL_TIMEOUT_MS = 45_000;
const MAX_REGISTRY_ENTRIES = 4096;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Deliberately discard tool_input, transcript paths, commands, and all extra fields. */
export function normalizeHookEvent(value: unknown, makeId: () => string = randomUUID, provider: AgentProvider = 'codex'): HookEvent | undefined {
  const event = record(value);
  if (!event || !validText(event.session_id, 200) || !validText(event.cwd, 4096)
    || !path.isAbsolute(event.cwd) || !validText(event.tool_name, 200)) return undefined;
  let kind: HookEvent['kind'];
  if (event.hook_event_name === 'PermissionRequest') kind = isQuestionTool(provider, event.tool_name) ? 'question' : 'permission';
  else if (event.hook_event_name === 'PreToolUse' && isQuestionTool(provider, event.tool_name)) kind = 'question';
  else return undefined;
  return { provider, kind, sessionId: event.session_id, requestId: makeId(), cwd: event.cwd, toolName: event.tool_name };
}

export function parseEndpoint(value: unknown, now = Date.now()): RegistryEndpoint | undefined {
  const endpoint = record(value);
  if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.length > 2048
    || typeof endpoint.token !== 'string' || endpoint.token.length < 32 || endpoint.token.length > 512
    || /\s|[\u0000-\u001f\u007f]/u.test(endpoint.token)
    || typeof endpoint.createdAt !== 'number' || !Number.isFinite(endpoint.createdAt)
    || endpoint.createdAt < now - MAX_ENDPOINT_AGE_MS || endpoint.createdAt > now + 5000
    || !Array.isArray(endpoint.workspaces) || !endpoint.workspaces.length || endpoint.workspaces.length > 100
    || !endpoint.workspaces.every((workspace) => validText(workspace, 4096) && path.isAbsolute(workspace))) return undefined;
  if (endpoint.providers !== undefined && (!Array.isArray(endpoint.providers)
    || !endpoint.providers.length || endpoint.providers.length > 2 || !endpoint.providers.every(isProvider))) return undefined;
  try {
    const url = new URL(endpoint.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/notify'
      || url.username || url.password || url.search || url.hash) return undefined;
    return {
      url: url.href, token: endpoint.token, workspaces: [...endpoint.workspaces] as string[], createdAt: endpoint.createdAt,
      ...(endpoint.providers === undefined ? {} : { providers: [...endpoint.providers] as AgentProvider[] }),
    };
  } catch { return undefined; }
}

async function canonicalPath(value: string): Promise<string> {
  try { return await realpath(value); } catch { return path.resolve(value); }
}

function contains(workspace: string, cwd: string): boolean {
  const relative = path.relative(workspace, cwd);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Group matching IDE instances by workspace specificity, newest first. */
async function endpointGroups(
  candidates: readonly unknown[],
  cwd: string,
  now = Date.now(),
  resolvePath: (value: string) => Promise<string> = canonicalPath,
  provider: AgentProvider = 'codex',
): Promise<RegistryEndpoint[][]> {
  if (!path.isAbsolute(cwd)) return [];
  const canonicalCwd = await resolvePath(cwd);
  const matches: Array<{ endpoint: RegistryEndpoint; length: number }> = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const endpoint = parseEndpoint(value, now);
    // Old Nod/Agent Alert windows know only Codex and must never decide for Claude.
    if (!endpoint || !(endpoint.providers ?? ['codex']).includes(provider)) continue;
    let length = -1;
    for (const workspace of endpoint.workspaces) {
      const canonical = await resolvePath(workspace);
      if (contains(canonical, canonicalCwd)) length = Math.max(length, canonical.length);
    }
    if (length < 0) continue;
    const key = `${endpoint.url}\n${endpoint.token}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ endpoint, length });
    }
  }
  matches.sort((left, right) => right.length - left.length
    || right.endpoint.createdAt - left.endpoint.createdAt
    || left.endpoint.url.localeCompare(right.endpoint.url));
  const groups: RegistryEndpoint[][] = [];
  let previousLength: number | undefined;
  for (const match of matches) {
    if (match.length !== previousLength) {
      groups.push([]);
      previousLength = match.length;
    }
    groups.at(-1)!.push(match.endpoint);
  }
  return groups;
}

/** Return every matching IDE endpoint, ordered by workspace specificity and freshness. */
export async function selectEndpoints(
  candidates: readonly unknown[],
  cwd: string,
  now = Date.now(),
  resolvePath: (value: string) => Promise<string> = canonicalPath,
  provider: AgentProvider = 'codex',
): Promise<RegistryEndpoint[]> {
  return (await endpointGroups(candidates, cwd, now, resolvePath, provider)).flat();
}

/** Prefer the most specific workspace and newest live IDE for compatibility. */
export async function selectEndpoint(
  candidates: readonly unknown[],
  cwd: string,
  now = Date.now(),
  resolvePath: (value: string) => Promise<string> = canonicalPath,
  provider: AgentProvider = 'codex',
): Promise<RegistryEndpoint | undefined> {
  return (await endpointGroups(candidates, cwd, now, resolvePath, provider))[0]?.[0];
}

/** Read only private, owned regular files; symlink registry entries are rejected. */
export async function discoverEndpoints(directory: string, now = Date.now()): Promise<RegistryEndpoint[]> {
  const endpoints: RegistryEndpoint[] = [];
  try {
    const entries = await opendir(directory);
    let count = 0;
    for await (const entry of entries) {
      if (!entry.name.endsWith('.json') || !entry.isFile()) continue;
      if (++count > MAX_REGISTRY_ENTRIES) break;
      let file;
      try {
        file = await open(path.join(directory, entry.name), constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) continue;
        if (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))) continue;
        const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
        }
        if (bytes > MAX_REGISTRY_BYTES) continue;
        const endpoint = parseEndpoint(JSON.parse(buffer.subarray(0, bytes).toString('utf8')), now);
        if (endpoint) endpoints.push(endpoint);
      } catch { /* Unavailable, malformed, or stale entries do not disrupt the agent. */ }
      finally { await file?.close().catch(() => undefined); }
    }
  } catch { /* A window may close or remove its registry while discovery runs. */ }
  return endpoints;
}

export function readBoundedInput(input: Readable, maxBytes = MAX_INPUT_BYTES, timeoutMs = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let complete = false;
    const finish = (value?: string): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onError);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) { chunks.length = 0; finish(); }
      else chunks.push(buffer);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = (): void => finish();
    const timer = setTimeout(() => finish(), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onError);
  });
}

export type HttpRequest = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export interface HookPostResult { delivered: boolean; allow: boolean }

/** The response is a tiny decision, never arbitrary hook output to pass through. */
export function deliverHookEvent(endpoint: RegistryEndpoint, event: HookEvent, timeoutMs = OVERALL_TIMEOUT_MS, send: HttpRequest = request): Promise<HookPostResult> {
  return new Promise((resolve) => {
    let complete = false;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    const finish = (delivered = false, allow = false): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      incoming?.destroy();
      outgoing?.destroy();
      resolve({ delivered, allow });
    };
    const timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
    try {
      const body = JSON.stringify(event);
      outgoing = send(new URL(endpoint.url), {
        method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
      }, (response) => {
        incoming = response;
        response.on('error', () => finish());
        response.once('aborted', () => finish());
        if (complete) { response.destroy(); return; }
        if (response.statusCode !== 200 || !/^application\/json(?:\s*;.*)?$/i.test(response.headers['content-type'] ?? '')
          || Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) { finish(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) { chunks.length = 0; finish(); }
          else chunks.push(buffer);
        });
        response.once('end', () => {
          if (complete) return;
          try {
            const result = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (typeof result?.allow !== 'boolean') finish();
            else finish(true, result.allow);
          }
          catch { finish(); }
        });
      });
      outgoing.on('error', () => finish());
      outgoing.end(body);
    } catch { finish(); }
  });
}

export async function postHookEvent(endpoint: RegistryEndpoint, event: HookEvent, timeoutMs = OVERALL_TIMEOUT_MS, send: HttpRequest = request): Promise<boolean> {
  return (await deliverHookEvent(endpoint, event, timeoutMs, send)).allow;
}

export function approvalOutput(event: HookEvent, allow: unknown): string | undefined {
  if (!isToolPermission(event) || allow !== true) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
}

export interface ClientOptions {
  args?: readonly string[];
  input?: Readable;
  write?: (output: string) => void | Promise<void>;
  discover?: (directory: string) => Promise<RegistryEndpoint[]>;
  post?: (endpoint: RegistryEndpoint, event: HookEvent, timeoutMs: number) => Promise<boolean | HookPostResult>;
  timeoutMs?: number;
}

export async function runHookClient(options: ClientOptions = {}): Promise<void> {
  const started = Date.now();
  const timeoutMs = Math.min(OVERALL_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? OVERALL_TIMEOUT_MS));
  const args = options.args ?? process.argv.slice(2);
  const index = args.indexOf('--registry');
  const directory = index < 0 ? undefined : args[index + 1];
  if (!directory || !path.isAbsolute(directory)) return;
  if (args.includes('--agent-alert-claude') && args.includes('--agent-alert-codex')) return;
  const provider: AgentProvider = args.includes('--agent-alert-claude') ? 'claude' : 'codex';
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const work = async (): Promise<void> => {
    const text = await readBoundedInput(options.input ?? process.stdin, MAX_INPUT_BYTES, Math.min(2000, timeoutMs));
    if (!text || expired) return;
    const event = normalizeHookEvent(JSON.parse(text), randomUUID, provider);
    if (!event) return;
    const endpoints = await (options.discover ?? discoverEndpoints)(directory);
    if (expired) return;
    const groups = await endpointGroups(endpoints, event.cwd, Date.now(), canonicalPath, provider);
    if (!groups.length || expired) return;
    for (const group of groups) {
      let delivered = false;
      for (const endpoint of group) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0 || expired) return;
        const raw = options.post
          ? await options.post(endpoint, event, remaining)
          : await deliverHookEvent(endpoint, event, remaining);
        // A boolean result is the legacy injected transport contract and means
        // that the endpoint answered. The detailed result enables dead-endpoint fallback.
        const result = typeof raw === 'boolean' ? { delivered: true, allow: raw } : raw;
        if (!result.delivered) continue;
        delivered = true;
        const output = approvalOutput(event, result.allow);
        if (output && !expired) {
          await (options.write ?? ((value) => new Promise<void>((resolve) => { process.stdout.write(value, () => resolve()); })))(output);
          return;
        }
        // Notify every equally specific IDE for questions and let another armed
        // window approve when the first matching window is alerts-only.
      }
      // A live instance at the most specific workspace owns this event. Only
      // fall back to a parent workspace when every endpoint in this tier is dead.
      if (delivered) return;
    }
  };
  try {
    await Promise.race([work(), new Promise<void>((resolve) => {
      timer = setTimeout(() => { expired = true; resolve(); }, timeoutMs);
    })]);
  } catch { /* Every failure is quiet and leaves the agent's normal decision UI intact. */ }
  finally { if (timer) clearTimeout(timer); }
}

if (require.main === module) {
  // This final deadline also bounds slow filesystem discovery or pipe shutdown.
  const deadline = setTimeout(() => process.exit(0), OVERALL_TIMEOUT_MS);
  deadline.unref();
  process.stdout.on('error', () => process.exit(0));
  void runHookClient().catch(() => undefined);
}
