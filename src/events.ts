export type AgentProvider = 'codex' | 'claude';

export interface HookEvent {
  provider: AgentProvider;
  kind: 'permission' | 'question';
  sessionId: string;
  requestId: string;
  cwd: string;
  toolName: string;
}

export function isProvider(value: unknown): value is AgentProvider {
  return value === 'codex' || value === 'claude';
}

export function providerName(provider: AgentProvider): string {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

export function isQuestionTool(provider: AgentProvider, toolName: string): boolean {
  return provider === 'claude' ? toolName === 'AskUserQuestion'
    : /(^|[._])request_user_input(_async)?$/.test(toolName);
}

export function isToolPermission(event: HookEvent): boolean {
  return event.kind === 'permission' && !isQuestionTool(event.provider, event.toolName);
}
