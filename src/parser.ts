import { redactString, redactValue } from './redact.js';
import type { CodexRunnerEvent, CodexRunnerUsage } from './types.js';

type RawRecord = Record<string, unknown>;

export class CodexJsonlParser {
  private readonly textByItemId = new Map<string, string>();
  private readonly reasoningTextByItemId = new Map<string, string>();
  private readonly toolCallSnapshots = new Map<string, string>();
  private readonly toolResultSnapshots = new Map<string, Set<string>>();
  private readonly emittedExecStarts = new Set<string>();
  private readonly emittedExecFinishes = new Set<string>();
  private syntheticItemCounter = 0;
  lastEvent: CodexRunnerEvent | undefined;

  parseLine(line: string): CodexRunnerEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      return [
        this.remember({
          kind: 'failed',
          code: 'stream_error',
          message: `invalid Codex JSONL: ${redactString((error as Error).message)}`,
        }),
      ];
    }

    return this.mapEvent(asRecord(raw));
  }

  private mapEvent(event: RawRecord): CodexRunnerEvent[] {
    const type = stringValue(event.type);
    switch (type) {
      case 'thread.started':
        return this.threadStarted(event);
      case 'turn.started':
        return [this.remember({ kind: 'turn_started' })];
      case 'turn.completed':
        return this.turnCompleted(event);
      case 'turn.failed':
        return [
          this.remember({
            kind: 'failed',
            code: 'turn_failed',
            message: extractErrorMessage(event.error) ?? 'turn failed',
          }),
        ];
      case 'error':
        return [
          this.remember({
            kind: 'failed',
            code: 'stream_error',
            message:
              extractErrorMessage(event.message ?? event.error) ??
              'Codex stream error',
          }),
        ];
      case 'turn.plan.updated':
      case 'plan_update':
        return this.planUpdate(event, true);
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.mapItem(asRecord(event.item), type === 'item.completed');
      default:
        return [this.remember({ kind: 'unknown', raw: redactValue(event) })];
    }
  }

  private threadStarted(event: RawRecord): CodexRunnerEvent[] {
    const codexSessionId =
      stringValue(event.thread_id) ??
      stringValue(event.threadId) ??
      stringValue(event.session_id) ??
      stringValue(event.sessionId) ??
      stringValue(event.id) ??
      stringValue(asRecord(event.thread).id);
    if (!codexSessionId) {
      return [this.remember({ kind: 'unknown', raw: redactValue(event) })];
    }
    return [this.remember({ kind: 'codex_session', codexSessionId })];
  }

  private turnCompleted(event: RawRecord): CodexRunnerEvent[] {
    const usage = normalizeUsage(event.usage);
    const events: CodexRunnerEvent[] = [];
    if (usage) events.push(this.remember({ kind: 'usage', usage }));
    events.push(this.remember({ kind: 'completed', usage, lastEvent: this.lastEvent }));
    return events;
  }

  private mapItem(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    if (!item) return [];
    const type = stringValue(item.type) ?? stringValue(item.item_type);

    switch (type) {
      case 'agent_message':
        return this.agentMessage(item, final);
      case 'reasoning':
        return this.reasoning(item, final);
      case 'file_change':
        return this.fileChange(item, final);
      case 'web_search':
        return this.webSearch(item, final);
      case 'todo_list':
        return this.todoList(item, final);
      case 'plan_update':
      case 'plan':
        return this.planUpdate(item, final);
      case 'approval_request':
      case 'exec_approval_request':
      case 'apply_patch_approval_request':
        return this.approvalRequest(item, type);
      case 'command':
      case 'command_execution':
        return this.commandExecution(item, final);
      case 'mcp_tool_call':
        return this.mcpToolCall(item, final);
      case 'function_call':
      case 'tool_call':
        return this.genericToolCall(item, final);
      case 'function_call_output':
      case 'tool_result':
        return this.genericToolResult(item);
      case 'error':
        return [
          this.remember({
            kind: 'failed',
            code: 'stream_error',
            message:
              extractErrorMessage(item.message ?? item.error) ??
              'Codex item error',
          }),
        ];
      default:
        return [this.remember({ kind: 'unknown', raw: redactValue(item) })];
    }
  }

  private agentMessage(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    const itemId = this.itemIdFor(item, undefined, 'message');
    const text = extractText(item);
    const events: CodexRunnerEvent[] = [];
    const previous = this.textByItemId.get(itemId) ?? '';
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta) {
      this.textByItemId.set(itemId, text);
      events.push(this.remember({ kind: 'text_delta', itemId, text: redactString(delta) }));
    }
    events.push(
      this.remember({
        kind: 'agent_message',
        itemId,
        text: redactString(text),
        final,
      }),
    );
    return events;
  }

  private reasoning(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    const itemId = this.itemIdFor(item, undefined, 'reasoning');
    const text = extractText(item);
    const previous = this.reasoningTextByItemId.get(itemId) ?? '';
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta) this.reasoningTextByItemId.set(itemId, text);
    return [
      this.remember({
        kind: 'reasoning',
        itemId,
        text: redactString(text),
        delta: delta ? redactString(delta) : undefined,
        final,
      }),
    ];
  }

  private fileChange(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    return [
      this.remember({
        kind: 'file_change',
        itemId: this.itemIdFor(item, undefined, 'file-change'),
        path:
          stringValue(item.path) ??
          stringValue(item.file_path) ??
          stringValue(item.filePath),
        status: stringValue(item.status),
        diff: stringValue(item.diff) ?? stringValue(item.patch),
        changes: redactValue(item.changes ?? item.files ?? item.content),
        raw: redactValue(item),
        final,
      }),
    ];
  }

  private webSearch(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    return [
      this.remember({
        kind: 'web_search',
        itemId: this.itemIdFor(item, undefined, 'web-search'),
        query: stringValue(item.query) ?? stringValue(asRecord(item.action).query),
        status: stringValue(item.status),
        results: redactValue(item.results ?? item.output ?? item.content),
        raw: redactValue(item),
        final,
      }),
    ];
  }

  private todoList(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    return [
      this.remember({
        kind: 'todo_list',
        itemId: this.itemIdFor(item, undefined, 'todo-list'),
        todos: redactValue(item.todos ?? item.items ?? item.content),
        status: stringValue(item.status),
        raw: redactValue(item),
        final,
      }),
    ];
  }

  private planUpdate(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    return [
      this.remember({
        kind: 'plan_update',
        itemId: this.itemIdFor(item, undefined, 'plan-update'),
        steps: redactValue(item.steps ?? item.plan ?? item.items ?? item.content),
        status: stringValue(item.status),
        raw: redactValue(item),
        final,
      }),
    ];
  }

  private approvalRequest(item: RawRecord, type: string): CodexRunnerEvent[] {
    const approvalType =
      type === 'exec_approval_request'
        ? 'exec'
        : type === 'apply_patch_approval_request'
          ? 'apply_patch'
          : normalizeApprovalType(stringValue(item.approval_type) ?? stringValue(item.approvalType));

    return [
      this.remember({
        kind: 'approval_request',
        approvalId:
          stringValue(item.approval_id) ??
          stringValue(item.approvalId) ??
          stringValue(item.call_id) ??
          this.itemIdFor(item, undefined, 'approval'),
        approvalType,
        command: stringValue(item.command) ?? stringValue(item.cmd),
        reason:
          stringValue(item.reason) ??
          stringValue(item.message) ??
          stringValue(item.description),
        status: stringValue(item.status),
        raw: redactValue(item),
      }),
    ];
  }

  private commandExecution(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    const execId = this.itemIdFor(item, undefined, 'exec');
    const command = redactString(stringValue(item.command) ?? '');
    const status = stringValue(item.status);
    const output = stringValue(item.aggregated_output) ?? stringValue(item.output);
    const exitCode = numberValue(item.exit_code);
    const events: CodexRunnerEvent[] = [];
    const redactedRaw = redactValue(item);

    if (!this.emittedExecStarts.has(execId)) {
      this.emittedExecStarts.add(execId);
      events.push(
        this.remember({
          kind: 'exec_started',
          execId,
          command,
          status,
          raw: redactedRaw,
        }),
      );
    }

    const terminalStatus = status === 'completed' || status === 'failed';
    if ((final || terminalStatus || exitCode !== undefined) && !this.emittedExecFinishes.has(execId)) {
      this.emittedExecFinishes.add(execId);
      events.push(
        this.remember({
          kind: 'exec_finished',
          execId,
          command,
          ok: exitCode === undefined ? status === 'completed' : exitCode === 0,
          exitCode,
          output: output === undefined ? undefined : redactString(output),
          status,
          raw: redactedRaw,
        }),
      );
    }

    return events;
  }

  private mcpToolCall(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    const toolCallId = this.itemIdFor(item, undefined, 'mcp-tool');
    const server = stringValue(item.server);
    const tool = stringValue(item.tool) ?? stringValue(item.name) ?? 'mcp_tool_call';
    const name = server ? `${server}.${tool}` : tool;
    const status = stringValue(item.status);
    const events = this.emitToolCallOnce(toolCallId, name, item.arguments, status, item);

    const error = extractErrorMessage(item.error);
    const terminalStatus = final || status === 'completed' || status === 'failed' || Boolean(error);
    if (terminalStatus) {
      const resultEvent = this.toolResultOnce({
        kind: 'tool_result',
        toolCallId,
        ok: !error && status !== 'failed',
        result: redactValue(item.result ?? item.output ?? item.content),
        error,
        raw: redactValue(item),
      });
      if (resultEvent) events.push(resultEvent);
    }

    return events;
  }

  private genericToolCall(item: RawRecord, final: boolean): CodexRunnerEvent[] {
    const toolCallId = this.itemIdFor(item, stringValue(item.call_id), 'tool');
    const name = stringValue(item.name) ?? stringValue(item.tool) ?? 'tool_call';
    const events = this.emitToolCallOnce(
      toolCallId,
      name,
      item.arguments ?? item.args,
      stringValue(item.status),
      item,
    );

    if (final && (item.output !== undefined || item.result !== undefined || item.error !== undefined)) {
      const result = item.result ?? item.output;
      const error = extractErrorMessage(item.error) ?? extractUnsupportedToolOutput(result);
      const resultEvent = this.toolResultOnce({
        kind: 'tool_result',
        toolCallId,
        ok: !error,
        result: redactValue(result),
        error,
        raw: redactValue(item),
      });
      if (resultEvent) events.push(resultEvent);
    }

    return events;
  }

  private genericToolResult(item: RawRecord): CodexRunnerEvent[] {
    const toolCallId = stringValue(item.call_id) ?? this.itemIdFor(item, undefined, 'tool-result');
    const result = item.output ?? item.result ?? item.content;
    const error = extractErrorMessage(item.error) ?? extractUnsupportedToolOutput(result);
    const event = this.toolResultOnce({
      kind: 'tool_result',
      toolCallId,
      ok: !error,
      result: redactValue(result),
      error,
      raw: redactValue(item),
    });
    return event ? [event] : [];
  }

  private emitToolCallOnce(
    toolCallId: string,
    name: string,
    args: unknown,
    status: string | undefined,
    raw: RawRecord,
  ): CodexRunnerEvent[] {
    const event = {
      kind: 'tool_call' as const,
      toolCallId,
      name,
      arguments: redactValue(args),
      status,
      raw: redactValue(raw),
    };
    const snapshot = stableStringify({
      name: event.name,
      arguments: event.arguments,
      status: event.status,
    });
    if (this.toolCallSnapshots.get(toolCallId) === snapshot) return [];
    this.toolCallSnapshots.set(toolCallId, snapshot);
    return [this.remember(event)];
  }

  private toolResultOnce(
    event: Extract<CodexRunnerEvent, { kind: 'tool_result' }>,
  ): Extract<CodexRunnerEvent, { kind: 'tool_result' }> | undefined {
    const snapshot = stableStringify({
      ok: event.ok,
      result: event.result,
      error: event.error,
    });
    const snapshots = this.toolResultSnapshots.get(event.toolCallId) ?? new Set<string>();
    if (snapshots.has(snapshot)) return undefined;
    snapshots.add(snapshot);
    this.toolResultSnapshots.set(event.toolCallId, snapshots);
    return this.remember(event);
  }

  private itemIdFor(item: RawRecord, fallback?: string, prefix = 'item'): string {
    return (
      stringValue(item.id) ??
      stringValue(item.item_id) ??
      stringValue(item.itemId) ??
      fallback ??
      `synthetic-${prefix}-${++this.syntheticItemCounter}`
    );
  }

  private remember<T extends CodexRunnerEvent>(event: T): T {
    this.lastEvent = event;
    return event;
  }
}

export function parseCodexJsonl(jsonl: string): CodexRunnerEvent[] {
  const parser = new CodexJsonlParser();
  return jsonl
    .split(/\r?\n/)
    .flatMap((line) => parser.parseLine(line));
}

function normalizeUsage(value: unknown): CodexRunnerUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = asRecord(value);
  return {
    inputTokens: numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0,
    cachedInputTokens:
      numberValue(usage.cached_input_tokens) ?? numberValue(usage.cachedInputTokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0,
    reasoningOutputTokens:
      numberValue(usage.reasoning_output_tokens) ??
      numberValue(usage.reasoningOutputTokens) ??
      0,
  };
}

function extractText(item: RawRecord): string {
  const text = stringValue(item.text);
  if (text !== undefined) return text;
  const summary = stringValue(item.summary);
  if (summary !== undefined) return summary;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = asRecord(part);
        return stringValue(record.text) ?? stringValue(record.content) ?? '';
      })
      .join('');
  }
  return '';
}

function extractUnsupportedToolOutput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (
    /^unsupported (?:custom )?tool call:/i.test(text) ||
    /^unsupported call:/i.test(text)
  ) {
    return redactString(text);
  }
  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return redactString(value);
  const record = asRecord(value);
  const message = stringValue(record.message) ?? stringValue(record.error);
  return message === undefined ? undefined : redactString(message);
}

function asRecord(value: unknown): RawRecord {
  return typeof value === 'object' && value !== null ? (value as RawRecord) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeApprovalType(value: string | undefined): 'exec' | 'apply_patch' | 'unknown' {
  if (value === 'exec' || value === 'command') return 'exec';
  if (value === 'apply_patch' || value === 'patch') return 'apply_patch';
  return 'unknown';
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as RawRecord;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortObject(record[key])]),
  );
}
