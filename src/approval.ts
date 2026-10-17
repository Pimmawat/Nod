import type { HookDecision, HookEvent } from './bridge';
import { isToolPermission } from './events';

export interface ApprovalSettings {
  enabled: boolean;
  armed: boolean;
  allowedTools: readonly string[];
  claudeAllowedTools?: readonly string[];
  delayMs: number;
}

export function canAutoApprove(event: HookEvent, settings: ApprovalSettings): boolean {
  const tools = event.provider === 'claude' ? settings.claudeAllowedTools ?? [] : settings.allowedTools;
  return isToolPermission(event) && settings.enabled && settings.armed &&
    tools.some((tool) => tool === '*' || tool === event.toolName);
}

type Schedule = (callback: () => void, delay: number) => () => void;

/** Owns pending native hook decisions, never keyboard input or chat answers. */
export class ApprovalController {
  private readonly pending = new Set<() => void>();
  private readonly seen = new Map<string, number>();
  private disposed = false;

  constructor(private readonly options: {
    settings: () => ApprovalSettings;
    notify: (event: HookEvent, automatic: boolean) => void;
    approved: (event: HookEvent) => void;
    schedule?: Schedule;
  }) {}

  async handle(event: HookEvent, signal: AbortSignal): Promise<HookDecision> {
    if (this.disposed || signal.aborted || !this.options.settings().enabled) return { allow: false };
    const now = Date.now();
    for (const [key, at] of this.seen) if (now - at > 60_000) this.seen.delete(key);
    const key = JSON.stringify([event.provider, event.sessionId, event.requestId]);
    if (this.seen.has(key)) return { allow: false };
    if (this.seen.size >= 512) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, now);
    const automatic = canAutoApprove(event, this.options.settings());
    this.options.notify(event, automatic);
    if (!automatic || this.disposed || signal.aborted) return { allow: false };

    const elapsed = await new Promise<boolean>((resolve) => {
      let finished = false;
      let cancelTimer: (() => void) | undefined;
      const finish = (value: boolean): void => {
        if (finished) return;
        finished = true;
        cancelTimer?.();
        signal.removeEventListener('abort', cancel);
        this.pending.delete(cancel);
        resolve(value);
      };
      const cancel = (): void => finish(false);
      this.pending.add(cancel);
      signal.addEventListener('abort', cancel, { once: true });
      const delay = Math.min(30_000, Math.max(1000, this.options.settings().delayMs || 3000));
      if (this.options.schedule) cancelTimer = this.options.schedule(() => finish(true), delay);
      else {
        const timer = setTimeout(() => finish(true), delay);
        cancelTimer = () => clearTimeout(timer);
      }
      if (signal.aborted) cancel();
    });
    const allow = elapsed && !this.disposed && !signal.aborted && canAutoApprove(event, this.options.settings());
    if (allow) this.options.approved(event);
    return { allow };
  }

  cancelAll(): void { for (const cancel of [...this.pending]) cancel(); }
  dispose(): void { this.disposed = true; this.cancelAll(); this.seen.clear(); }
}
