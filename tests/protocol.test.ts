import { describe, expect, it } from 'vitest';
import {
  createProtocolEventMapper,
  toAgentStreamEvent,
  type CodexRunnerEvent,
} from '../src/index.js';

describe('protocol event adapter', () => {
  it('maps runner kind events to protocol type events', () => {
    const mapper = createProtocolEventMapper({
      turnId: 'turn-1',
      cwd: '/repo',
      now: () => 123,
    });

    const events: CodexRunnerEvent[] = [
      { kind: 'codex_session', codexSessionId: 'codex-session-1' },
      { kind: 'turn_started' },
      { kind: 'text_delta', itemId: 'msg-1', text: 'hel' },
      { kind: 'agent_message', itemId: 'msg-1', text: 'hello', final: false },
      { kind: 'agent_message', itemId: 'msg-1', text: 'hello', final: true },
      { kind: 'reasoning', itemId: 'reason-1', text: 'thinking', delta: 'thinking', final: true },
      { kind: 'file_change', itemId: 'file-1', path: 'src/app.ts', status: 'modified', final: true },
      { kind: 'web_search', itemId: 'search-1', query: 'codex sdk', status: 'completed', final: true },
      { kind: 'todo_list', itemId: 'todo-1', todos: [{ text: 'test', status: 'completed' }], final: true },
      { kind: 'plan_update', itemId: 'plan-1', steps: [{ step: 'test', status: 'completed' }], final: true },
      { kind: 'approval_request', approvalId: 'approval-1', approvalType: 'exec', command: 'pnpm test' },
      { kind: 'tool_call', toolCallId: 'tool-1', name: 'github.get_issue', arguments: { number: 1 } },
      { kind: 'tool_result', toolCallId: 'tool-1', ok: true, result: { title: 'bug' } },
      { kind: 'exec_started', execId: 'exec-1', command: 'pnpm test' },
      { kind: 'exec_finished', execId: 'exec-1', command: 'pnpm test', ok: true, exitCode: 0, output: 'ok' },
      {
        kind: 'usage',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 3,
        },
      },
      {
        kind: 'completed',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 3,
        },
      },
      { kind: 'failed', code: 'codex_exit', message: 'boom', exitCode: 1, stderr: 'nope' },
      { kind: 'aborted', reason: 'timeout' },
      { kind: 'unknown', raw: { type: 'future.event' } },
    ];

    const protocolEvents = events.map(mapper);

    expect(protocolEvents.map((event) => event.type)).toEqual([
      'thread_started',
      'turn_started',
      'assistant_message',
      'assistant_message',
      'assistant_message',
      'reasoning',
      'file_change',
      'web_search',
      'todo_list',
      'plan_update',
      'approval_request',
      'tool_call',
      'tool_result',
      'exec_begin',
      'exec_end',
      'usage',
      'turn_completed',
      'turn_failed',
      'turn_aborted',
      'raw',
    ]);
    expect(protocolEvents[0]).toMatchObject({
      type: 'thread_started',
      at: 123,
      seq: 1,
      threadId: 'codex-session-1',
      sessionId: 'codex-session-1',
    });
    expect(protocolEvents[0]).not.toHaveProperty('turnId');
    expect(protocolEvents[2]).toMatchObject({
      type: 'assistant_message',
      messageId: 'msg-1',
      text: 'hel',
      delta: 'hel',
      partial: true,
      threadId: 'codex-session-1',
      sessionId: 'codex-session-1',
    });
    expect(protocolEvents[4]).toMatchObject({
      type: 'assistant_message',
      messageId: 'msg-1',
      text: 'hello',
      partial: false,
    });
    expect(protocolEvents[6]).toMatchObject({
      type: 'file_change',
      itemId: 'file-1',
      path: 'src/app.ts',
      status: 'modified',
      partial: false,
    });
    expect(protocolEvents[7]).toMatchObject({
      type: 'web_search',
      itemId: 'search-1',
      query: 'codex sdk',
      status: 'completed',
      partial: false,
    });
    expect(protocolEvents[8]).toMatchObject({
      type: 'todo_list',
      itemId: 'todo-1',
      todos: [{ text: 'test', status: 'completed' }],
      partial: false,
    });
    expect(protocolEvents[9]).toMatchObject({
      type: 'plan_update',
      itemId: 'plan-1',
      steps: [{ step: 'test', status: 'completed' }],
      partial: false,
    });
    expect(protocolEvents[10]).toMatchObject({
      type: 'approval_request',
      approvalId: 'approval-1',
      approvalType: 'exec',
      command: 'pnpm test',
    });
    expect(protocolEvents[13]).toMatchObject({
      type: 'exec_begin',
      callId: 'exec-1',
      command: 'pnpm test',
      cwd: '/repo',
    });
    expect(protocolEvents[14]).toMatchObject({
      type: 'exec_end',
      callId: 'exec-1',
      exitCode: 0,
      stdout: 'ok',
    });
    expect(protocolEvents[15]).toMatchObject({
      type: 'usage',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3,
        totalTokens: 15,
      },
    });
    expect(protocolEvents[16]).toMatchObject({
      type: 'turn_completed',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3,
        totalTokens: 15,
      },
    });
    expect(protocolEvents[17]).toMatchObject({
      type: 'turn_failed',
      error: {
        code: 'codex_exit',
        message: 'boom',
        cause: {
          exitCode: 1,
          stderr: 'nope',
        },
      },
    });
    expect(protocolEvents[19]).toMatchObject({
      type: 'raw',
      source: 'codex-runner',
      payload: { type: 'future.event' },
    });
  });

  it('maps resumed turn aborts with caller-provided thread and session ids', () => {
    const event = toAgentStreamEvent(
      { kind: 'aborted', reason: 'signal', exitCode: null },
      {
        turnId: 'resume-turn-1',
        threadId: 'codex-session-1',
        sessionId: 'codex-session-1',
        seq: 7,
        now: () => 456,
      },
    );

    expect(event).toEqual({
      type: 'turn_aborted',
      at: 456,
      seq: 7,
      turnId: 'resume-turn-1',
      threadId: 'codex-session-1',
      sessionId: 'codex-session-1',
      reason: 'signal',
    });
  });

  it('uses terminal event codexSessionId when no prior session context exists', () => {
    const event = toAgentStreamEvent(
      { kind: 'completed', codexSessionId: 'session-from-terminal' },
      {
        turnId: 'turn-1',
        seq: 1,
        now: () => 789,
      },
    );

    expect(event).toEqual({
      type: 'turn_completed',
      at: 789,
      seq: 1,
      turnId: 'turn-1',
      threadId: 'session-from-terminal',
      sessionId: 'session-from-terminal',
    });
  });
});
