import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexJsonl } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseCodexJsonl', () => {
  it('maps Codex 0.130 command_execution, text deltas, tools, usage, and session id', () => {
    const fixture = readFileSync(
      join(__dirname, 'fixtures/codex-0130-command.jsonl'),
      'utf8',
    );

    const events = parseCodexJsonl(fixture);

    expect(events).toContainEqual({
      kind: 'codex_session',
      codexSessionId: 'codex-session-123',
    });
    expect(events.filter((event) => event.kind === 'text_delta')).toEqual([
      { kind: 'text_delta', itemId: 'msg-1', text: 'Hello' },
      { kind: 'text_delta', itemId: 'msg-1', text: ' world' },
    ]);
    expect(events).toContainEqual({
      kind: 'agent_message',
      itemId: 'msg-1',
      text: 'Hello world',
      final: true,
    });
    expect(events).toContainEqual({
      kind: 'reasoning',
      itemId: 'reason-1',
      text: 'Need inspect repo',
      delta: 'Need inspect repo',
      final: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'exec_started',
        execId: 'exec-1',
        command: 'pnpm test',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'exec_finished',
        execId: 'exec-1',
        command: 'pnpm test',
        ok: true,
        exitCode: 0,
        output: 'ok 1 test',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_call',
        toolCallId: 'tool-1',
        name: 'github.get_pull_request',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        toolCallId: 'tool-1',
        ok: true,
      }),
    );
    expect(events).toContainEqual({
      kind: 'usage',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3,
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: 'completed' });
  });

  it('redacts secrets from emitted raw payloads and text', () => {
    const events = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'exec-secret',
            type: 'command_execution',
            command: 'echo API_KEY=abc1234567890',
            status: 'failed',
            aggregated_output: 'Bearer super-secret-token',
            exit_code: 1,
            env: { OPENAI_API_KEY: 'sk-proj-abc1234567890secret' },
          },
        }),
      ].join('\n'),
    );

    expect(JSON.stringify(events)).not.toContain('super-secret-token');
    expect(JSON.stringify(events)).not.toContain('sk-proj-abc1234567890secret');
    expect(JSON.stringify(events)).toContain('[REDACTED]');
  });

  it('extracts session ids from compatible thread.started field names', () => {
    expect(
      parseCodexJsonl(
        JSON.stringify({
          type: 'thread.started',
          session_id: 'session-from-snake-case',
        }),
      ),
    ).toEqual([
      {
        kind: 'codex_session',
        codexSessionId: 'session-from-snake-case',
      },
    ]);

    expect(
      parseCodexJsonl(
        JSON.stringify({
          type: 'thread.started',
          thread: { id: 'session-from-nested-thread' },
        }),
      ),
    ).toEqual([
      {
        kind: 'codex_session',
        codexSessionId: 'session-from-nested-thread',
      },
    ]);
  });

  it('adds stable error codes for parser-originated failures', () => {
    expect(parseCodexJsonl('{bad json')[0]).toMatchObject({
      kind: 'failed',
      code: 'stream_error',
    });

    expect(
      parseCodexJsonl(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'model failed' },
        }),
      )[0],
    ).toMatchObject({
      kind: 'failed',
      code: 'turn_failed',
      message: 'model failed',
    });
  });

  it('redacts object-shaped error messages', () => {
    const events = parseCodexJsonl(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Bearer abc.def.ghi' },
      }),
    );

    expect(events).toEqual([
      {
        kind: 'failed',
        code: 'turn_failed',
        message: '[REDACTED]',
      },
    ]);
  });

  it('does not emit zero usage when turn.completed omits usage', () => {
    const events = parseCodexJsonl(
      JSON.stringify({
        type: 'turn.completed',
      }),
    );

    expect(events).toEqual([
      {
        kind: 'completed',
        usage: undefined,
        lastEvent: undefined,
      },
    ]);
  });

  it('maps file changes, web search, todo lists, plan updates, and approval requests', () => {
    const events = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'file-1',
            type: 'file_change',
            path: 'src/app.ts',
            status: 'modified',
            diff: '+console.log("ok")',
          },
        }),
        JSON.stringify({
          type: 'item.updated',
          item: {
            id: 'search-1',
            type: 'web_search',
            query: 'codex cli sdk',
            status: 'running',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'todo-1',
            type: 'todo_list',
            todos: [{ text: 'write tests', status: 'completed' }],
          },
        }),
        JSON.stringify({
          type: 'item.updated',
          item: {
            id: 'plan-1',
            type: 'plan_update',
            steps: [{ step: 'write tests', status: 'in_progress' }],
          },
        }),
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'approval-1',
            type: 'exec_approval_request',
            command: 'pnpm test',
            reason: 'verify changes',
          },
        }),
      ].join('\n'),
    );

    expect(events).toContainEqual({
      kind: 'file_change',
      itemId: 'file-1',
      path: 'src/app.ts',
      status: 'modified',
      diff: '+console.log("ok")',
      changes: undefined,
      raw: expect.objectContaining({ type: 'file_change' }),
      final: true,
    });
    expect(events).toContainEqual({
      kind: 'web_search',
      itemId: 'search-1',
      query: 'codex cli sdk',
      status: 'running',
      results: undefined,
      raw: expect.objectContaining({ type: 'web_search' }),
      final: false,
    });
    expect(events).toContainEqual({
      kind: 'todo_list',
      itemId: 'todo-1',
      todos: [{ text: 'write tests', status: 'completed' }],
      status: undefined,
      raw: expect.objectContaining({ type: 'todo_list' }),
      final: true,
    });
    expect(events).toContainEqual({
      kind: 'plan_update',
      itemId: 'plan-1',
      steps: [{ step: 'write tests', status: 'in_progress' }],
      status: undefined,
      raw: expect.objectContaining({ type: 'plan_update' }),
      final: false,
    });
    expect(events).toContainEqual({
      kind: 'approval_request',
      approvalId: 'approval-1',
      approvalType: 'exec',
      command: 'pnpm test',
      reason: 'verify changes',
      status: undefined,
      raw: expect.objectContaining({ type: 'exec_approval_request' }),
    });
  });

  it('uses synthetic ids so id-less items do not overwrite each other', () => {
    const events = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.started',
          item: { type: 'tool_call', name: 'first', arguments: { a: 1 } },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { type: 'tool_call', name: 'second', arguments: { b: 2 } },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', command: 'pwd', status: 'in_progress' },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', command: 'ls', status: 'in_progress' },
        }),
      ].join('\n'),
    );

    const toolIds = events
      .filter((event) => event.kind === 'tool_call')
      .map((event) => event.toolCallId);
    const execIds = events
      .filter((event) => event.kind === 'exec_started')
      .map((event) => event.execId);

    expect(new Set(toolIds).size).toBe(2);
    expect(new Set(execIds).size).toBe(2);
    expect([...toolIds, ...execIds]).not.toContain('unknown');
  });

  it('emits tool call updates and deduplicates identical tool results', () => {
    const events = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'tool-1',
            type: 'tool_call',
            name: 'lookup',
            arguments: { query: 'one' },
            status: 'in_progress',
          },
        }),
        JSON.stringify({
          type: 'item.updated',
          item: {
            id: 'tool-1',
            type: 'tool_call',
            name: 'lookup',
            arguments: { query: 'two' },
            status: 'in_progress',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'tool-1',
            type: 'tool_call',
            name: 'lookup',
            arguments: { query: 'two' },
            output: { ok: true },
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'tool-1',
            type: 'tool_call',
            name: 'lookup',
            arguments: { query: 'two' },
            output: { ok: true },
          },
        }),
      ].join('\n'),
    );

    expect(events.filter((event) => event.kind === 'tool_call')).toHaveLength(3);
    expect(events.filter((event) => event.kind === 'tool_result')).toHaveLength(1);
  });

  it('marks unsupported Codex tool outputs as failed tool results', () => {
    const events = parseCodexJsonl(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'call-1',
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'unsupported call: exec_commandexec_command',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'call-2',
            type: 'tool_call',
            name: 'apply_patch',
            output: 'unsupported custom tool call: apply_patchapply_patch',
          },
        }),
      ].join('\n'),
    );

    expect(events).toContainEqual({
      kind: 'tool_result',
      toolCallId: 'call-1',
      ok: false,
      result: 'unsupported call: exec_commandexec_command',
      error: 'unsupported call: exec_commandexec_command',
      raw: expect.objectContaining({ type: 'function_call_output' }),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        toolCallId: 'call-2',
        ok: false,
        error: 'unsupported custom tool call: apply_patchapply_patch',
      }),
    );
  });
});
