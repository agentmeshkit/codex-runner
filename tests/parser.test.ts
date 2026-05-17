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
});
