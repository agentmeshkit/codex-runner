import type { CodexRunnerEvent, CodexRunnerUsage } from './types.js';

export type AgentThreadId = string;
export type AgentSessionId = string;
export type AgentTurnId = string;
export type AgentMessageId = string;
export type AgentToolCallId = string;

export interface AgentModelMetadata {
  provider?: string;
  model?: string;
  displayName?: string;
  accountLabel?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface AgentError {
  message: string;
  code?: string;
  recoverable?: boolean;
  cause?: unknown;
}

export interface AgentStreamEventBase {
  type: string;
  at: number;
  sessionId?: AgentSessionId;
  threadId?: AgentThreadId;
  turnId?: AgentTurnId;
  seq?: number;
}

export interface ThreadStartedEvent extends AgentStreamEventBase {
  type: 'thread_started';
  threadId: AgentThreadId;
  sessionId?: AgentSessionId;
  title?: string;
  model?: AgentModelMetadata;
}

export interface TurnStartedEvent extends AgentStreamEventBase {
  type: 'turn_started';
  turnId: AgentTurnId;
  model?: AgentModelMetadata;
}

export interface AssistantMessageEvent extends AgentStreamEventBase {
  type: 'assistant_message';
  turnId: AgentTurnId;
  messageId: AgentMessageId;
  text: string;
  partial?: boolean;
  delta?: string;
  usage?: TokenUsage;
}

export interface ReasoningEvent extends AgentStreamEventBase {
  type: 'reasoning';
  turnId: AgentTurnId;
  itemId?: string;
  text?: string;
  delta?: string;
  partial?: boolean;
  summary?: string;
}

export interface FileChangeEvent extends AgentStreamEventBase {
  type: 'file_change';
  turnId: AgentTurnId;
  itemId: string;
  path?: string;
  status?: string;
  diff?: string;
  changes?: unknown;
  partial?: boolean;
}

export interface WebSearchEvent extends AgentStreamEventBase {
  type: 'web_search';
  turnId: AgentTurnId;
  itemId: string;
  query?: string;
  status?: string;
  results?: unknown;
  partial?: boolean;
}

export interface TodoListEvent extends AgentStreamEventBase {
  type: 'todo_list';
  turnId: AgentTurnId;
  itemId: string;
  todos?: unknown;
  status?: string;
  partial?: boolean;
}

export interface ApprovalRequestEvent extends AgentStreamEventBase {
  type: 'approval_request';
  turnId: AgentTurnId;
  approvalId: string;
  approvalType: 'exec' | 'apply_patch' | 'unknown';
  command?: string;
  reason?: string;
  status?: string;
}

export interface ToolCallEvent extends AgentStreamEventBase {
  type: 'tool_call';
  turnId: AgentTurnId;
  callId: AgentToolCallId;
  name: string;
  args?: unknown;
  toolType?: string;
}

export interface ToolResultEvent extends AgentStreamEventBase {
  type: 'tool_result';
  turnId: AgentTurnId;
  callId: AgentToolCallId;
  name?: string;
  ok: boolean;
  output?: unknown;
  error?: AgentError | string;
}

export interface ExecBeginEvent extends AgentStreamEventBase {
  type: 'exec_begin';
  turnId: AgentTurnId;
  callId: AgentToolCallId;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecEndEvent extends AgentStreamEventBase {
  type: 'exec_end';
  turnId: AgentTurnId;
  callId: AgentToolCallId;
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface UsageEvent extends AgentStreamEventBase {
  type: 'usage';
  turnId: AgentTurnId;
  usage: TokenUsage;
  model?: AgentModelMetadata;
}

export interface RawEvent extends AgentStreamEventBase {
  type: 'raw';
  source?: string;
  payload: unknown;
}

export interface TurnCompletedEvent extends AgentStreamEventBase {
  type: 'turn_completed';
  turnId: AgentTurnId;
  usage?: TokenUsage;
}

export interface TurnFailedEvent extends AgentStreamEventBase {
  type: 'turn_failed';
  turnId: AgentTurnId;
  error: AgentError;
  usage?: TokenUsage;
}

export interface TurnAbortedEvent extends AgentStreamEventBase {
  type: 'turn_aborted';
  turnId: AgentTurnId;
  reason?: string;
  usage?: TokenUsage;
}

export type AgentStreamEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | FileChangeEvent
  | WebSearchEvent
  | TodoListEvent
  | ApprovalRequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | ExecBeginEvent
  | ExecEndEvent
  | UsageEvent
  | RawEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnAbortedEvent;

export type ProtocolEventMapperContext = {
  turnId: AgentTurnId;
  sessionId?: AgentSessionId;
  threadId?: AgentThreadId;
  seq?: number;
  now?: () => number;
  model?: AgentModelMetadata;
  cwd?: string;
  source?: string;
};

export type ProtocolEventMapper = (event: CodexRunnerEvent) => AgentStreamEvent;

type ProtocolBaseEvent = Omit<AgentStreamEventBase, 'type'> & {
  turnId: AgentTurnId;
};

export function createProtocolEventMapper(
  context: ProtocolEventMapperContext,
): ProtocolEventMapper {
  let seq = context.seq ?? 0;
  let sessionId = context.sessionId;
  let threadId = context.threadId;

  return (event) => {
    if (event.kind === 'codex_session') {
      sessionId ??= event.codexSessionId;
      threadId ??= event.codexSessionId;
    }

    seq += 1;
    return toAgentStreamEvent(event, {
      ...context,
      sessionId,
      threadId,
      seq,
    });
  };
}

export function toAgentStreamEvent(
  event: CodexRunnerEvent,
  context: ProtocolEventMapperContext,
): AgentStreamEvent {
  const base = baseEvent(context);

  switch (event.kind) {
    case 'codex_session': {
      const threadId = context.threadId ?? event.codexSessionId;
      return withoutUndefined({
        type: 'thread_started',
        at: base.at,
        sessionId: context.sessionId ?? event.codexSessionId,
        threadId,
        seq: base.seq,
        model: context.model,
      });
    }
    case 'turn_started':
      return withoutUndefined({
        ...base,
        type: 'turn_started',
        model: context.model,
      });
    case 'text_delta':
      return withoutUndefined({
        ...base,
        type: 'assistant_message',
        messageId: event.itemId,
        text: event.text,
        delta: event.text,
        partial: true,
      });
    case 'agent_message':
      return withoutUndefined({
        ...base,
        type: 'assistant_message',
        messageId: event.itemId,
        text: event.text,
        partial: !event.final,
      });
    case 'reasoning':
      return withoutUndefined({
        ...base,
        type: 'reasoning',
        itemId: event.itemId,
        text: event.text,
        partial: !event.final,
      });
    case 'file_change':
      return withoutUndefined({
        ...base,
        type: 'file_change',
        itemId: event.itemId,
        path: event.path,
        status: event.status,
        diff: event.diff,
        changes: event.changes,
        partial: !event.final,
      });
    case 'web_search':
      return withoutUndefined({
        ...base,
        type: 'web_search',
        itemId: event.itemId,
        query: event.query,
        status: event.status,
        results: event.results,
        partial: !event.final,
      });
    case 'todo_list':
      return withoutUndefined({
        ...base,
        type: 'todo_list',
        itemId: event.itemId,
        todos: event.todos,
        status: event.status,
        partial: !event.final,
      });
    case 'approval_request':
      return withoutUndefined({
        ...base,
        type: 'approval_request',
        approvalId: event.approvalId,
        approvalType: event.approvalType,
        command: event.command,
        reason: event.reason,
        status: event.status,
      });
    case 'tool_call':
      return withoutUndefined({
        ...base,
        type: 'tool_call',
        callId: event.toolCallId,
        name: event.name,
        args: event.arguments,
      });
    case 'tool_result':
      return withoutUndefined({
        ...base,
        type: 'tool_result',
        callId: event.toolCallId,
        ok: event.ok,
        output: event.result,
        error: event.error,
      });
    case 'exec_started':
      return withoutUndefined({
        ...base,
        type: 'exec_begin',
        callId: event.execId,
        command: event.command,
        cwd: context.cwd,
      });
    case 'exec_finished':
      return withoutUndefined({
        ...base,
        type: 'exec_end',
        callId: event.execId,
        exitCode: event.exitCode ?? null,
        stdout: event.output,
      });
    case 'usage':
      return withoutUndefined({
        ...base,
        type: 'usage',
        usage: toTokenUsage(event.usage),
        model: context.model,
      });
    case 'completed':
      return withoutUndefined({
        ...base,
        type: 'turn_completed',
        usage: event.usage ? toTokenUsage(event.usage) : undefined,
      });
    case 'failed':
      return withoutUndefined({
        ...base,
        type: 'turn_failed',
        error: {
          message: event.message,
          code: event.code,
          cause: withoutUndefined({
            exitCode: event.exitCode,
            stderr: event.stderr,
          }),
        },
      });
    case 'aborted':
      return withoutUndefined({
        ...base,
        type: 'turn_aborted',
        reason: event.reason,
      });
    case 'unknown':
      return withoutUndefined({
        ...base,
        type: 'raw',
        source: context.source ?? 'codex-runner',
        payload: event.raw,
      });
  }
}

function baseEvent(context: ProtocolEventMapperContext): ProtocolBaseEvent {
  return withoutUndefined({
    at: context.now?.() ?? Date.now(),
    sessionId: context.sessionId,
    threadId: context.threadId,
    turnId: context.turnId,
    seq: context.seq,
  });
}

function toTokenUsage(usage: CodexRunnerUsage): TokenUsage {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return withoutUndefined({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens,
  });
}

function withoutUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
