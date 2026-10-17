import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isProvider, isQuestionTool, isToolPermission, type HookEvent } from './events';
export type { HookEvent } from './events';

export interface HookDecision { allow: boolean }

export const MAX_NOTIFICATION_BYTES = 32 * 1024;

export function parseHookEvent(value: unknown): HookEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.kind !== 'permission' && event.kind !== 'question') return undefined;
  // Keep previously installed Codex helpers working until Setup is run again.
  const provider = event.provider === undefined ? 'codex' : event.provider;
  if (!isProvider(provider)) return undefined;
  const validText = (text: unknown, limit: number): text is string =>
    typeof text === 'string' && text.trim().length > 0 && text.length <= limit
    && !/[\u0000-\u001f\u007f]/u.test(text);
  if (!validText(event.sessionId, 200) || !validText(event.requestId, 200)
    || !validText(event.cwd, 4096) || !validText(event.toolName, 200)) return undefined;
  // Keep paths and identifiers intact, and drop every unrelated input field.
  return {
    provider,
    kind: isQuestionTool(provider, event.toolName) ? 'question' : event.kind,
    sessionId: event.sessionId,
    requestId: event.requestId,
    cwd: event.cwd,
    toolName: event.toolName,
  };
}

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Local native hooks exchange only event metadata and an approval decision. */
export class NotificationBridge {
  private readonly token = randomBytes(32).toString('hex');
  private server: Server | undefined;
  private starting: Promise<{ url: string; token: string }> | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private disposed = false;
  private readonly activeRequests = new Set<() => void>();

  constructor(
    private readonly onEvent: (event: HookEvent, signal: AbortSignal) => Promise<HookDecision>,
    private readonly log: (message: string) => void,
  ) {}

  start(): Promise<{ url: string; token: string }> {
    if (this.disposed) return Promise.reject(new Error('Notification bridge has been disposed.'));
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.rejectStart = reject;
      const server = createServer({ maxHeaderSize: 4096, connectionsCheckingInterval: 1000 }, (request, response) => {
        this.handle(request, response);
      });
      this.server = server;
      server.maxConnections = 16;
      server.maxHeadersCount = 20;
      server.headersTimeout = 2000;
      server.requestTimeout = 2000;
      server.keepAliveTimeout = 1000;
      server.setTimeout(60_000, (socket) => socket.destroy());
      let listening = false;
      server.on('error', () => {
        if (!listening) {
          this.rejectStart = undefined;
          reject(new Error('Could not start the local notification bridge.'));
        } else this.safeLog('The local notification bridge encountered a network error.');
      });
      server.listen(0, '127.0.0.1', () => {
        listening = true;
        this.rejectStart = undefined;
        if (this.disposed) {
          server.close();
          reject(new Error('Notification bridge has been disposed.'));
          return;
        }
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('The local notification bridge has no port.'));
          return;
        }
        server.unref();
        resolve({ url: `http://127.0.0.1:${address.port}/notify`, token: this.token });
      });
    });
    return this.starting;
  }

  dispose(): void {
    this.disposed = true;
    this.rejectStart?.(new Error('Notification bridge has been disposed.'));
    this.rejectStart = undefined;
    for (const cancel of this.activeRequests) cancel();
    // Closing before listen completes can cancel Node's listening callback.
    // A pending callback observes disposed and closes the server itself.
    if (this.server?.listening) {
      this.server.closeAllConnections();
      this.server.close();
    }
  }

  private safeLog(message: string): void {
    try { this.log(message); } catch { /* Logging must not disrupt an agent hook. */ }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const rejectRequest = (status: number): void => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { Connection: 'close', 'Cache-Control': 'no-store' });
      response.end();
    };
    if (this.disposed) { rejectRequest(503); return; }
    if (request.headers.origin !== undefined) { rejectRequest(403); return; }
    if (request.method !== 'POST' || request.url !== '/notify') { rejectRequest(404); return; }
    if (!isAuthorized(request.headers.authorization, this.token)) { rejectRequest(401); return; }
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
      rejectRequest(415);
      return;
    }
    const declaredSize = Number(request.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_NOTIFICATION_BYTES) {
      rejectRequest(413);
      return;
    }

    const chunks: Buffer[] = [];
    const controller = new AbortController();
    let size = 0;
    let inputComplete = false;
    let finished = false;
    const cleanup = (): void => {
      clearTimeout(inputTimer);
      clearTimeout(overallTimer);
      chunks.length = 0;
      this.activeRequests.delete(cancel);
    };
    const finish = (status: number, allow = false): void => {
      if (finished) return;
      finished = true;
      cleanup();
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, {
        Connection: 'close', 'Cache-Control': 'no-store', 'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ allow }));
    };
    const cancel = (): void => {
      controller.abort();
      finish(200);
    };
    const inputTimer = setTimeout(() => {
      controller.abort();
      finish(408);
    }, 2000);
    const overallTimer = setTimeout(cancel, 60_000);
    inputTimer.unref();
    overallTimer.unref();
    this.activeRequests.add(cancel);
    response.once('close', () => {
      if (!response.writableFinished) cancel();
    });
    request.once('error', cancel);
    request.once('aborted', cancel);
    request.on('data', (chunk: Buffer) => {
      if (inputComplete || finished) return;
      size += chunk.length;
      if (size > MAX_NOTIFICATION_BYTES) { finish(413); return; }
      chunks.push(chunk);
    });
    request.once('end', () => {
      clearTimeout(inputTimer);
      if (finished || this.disposed) return;
      inputComplete = true;
      let event: HookEvent | undefined;
      try { event = parseHookEvent(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(400); return; }
      chunks.length = 0;
      if (!event) { finish(400); return; }
      const received = event;
      void Promise.resolve().then(() => {
        if (controller.signal.aborted || this.disposed) return { allow: false };
        return this.onEvent(received, controller.signal);
      }).then((decision) => {
        finish(200, !controller.signal.aborted && !this.disposed
          && isToolPermission(received) && decision?.allow === true);
      }).catch(() => {
        if (!controller.signal.aborted) {
          this.safeLog('Could not handle the agent hook. The normal approval prompt will continue.');
        }
        finish(200);
      });
    });
  }
}
