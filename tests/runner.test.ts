import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildCodexExecArgs,
  createCodexRunner,
  type CodexChildProcess,
  type CodexExecInvocation,
  type CodexRunnerEvent,
} from '../src/index.js';

class FakeChild extends EventEmitter implements CodexChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', null, 'SIGTERM');
    });
    return true;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('buildCodexExecArgs', () => {
  it('builds first-turn codex exec argv with conservative defaults', () => {
    expect(
      buildCodexExecArgs({
        prompt: 'inspect',
        cwd: '/repo',
      }),
    ).toEqual(['exec', '--json', '--color', 'never', '-C', '/repo', 'inspect']);
  });

  it('builds first-turn codex exec argv with explicit cwd, model, and sandbox', () => {
    expect(
      buildCodexExecArgs({
        prompt: 'inspect',
        cwd: '/repo',
        model: 'gpt-5.4',
        sandbox: 'read-only',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '-m',
      'gpt-5.4',
      '-C',
      '/repo',
      '--sandbox',
      'read-only',
      'inspect',
    ]);
  });

  it('builds resume argv with the same explicit exec options', () => {
    expect(
      buildCodexExecArgs(
        {
          prompt: 'continue',
          cwd: '/repo',
          sandbox: 'danger-full-access',
          skipGitRepoCheck: true,
        },
        'session-1',
      ),
    ).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '-C',
      '/repo',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      'resume',
      'session-1',
      'continue',
    ]);
  });

  it('builds argv with explicit high-permission and automation options', () => {
    expect(
      buildCodexExecArgs({
        prompt: 'ship it',
        cwd: '/repo',
        approvalMode: 'never',
        sandbox: 'danger-full-access',
        dangerouslyBypassApprovalsAndSandbox: true,
        ephemeral: true,
        ignoreUserConfig: true,
        ignoreRules: true,
        profile: 'ci',
        config: ['model="gpt-5.4"', 'shell_environment_policy.inherit=all'],
        images: ['/tmp/a.png', '/tmp/b.png'],
        addDirs: ['/tmp/work'],
        outputLastMessagePath: '/tmp/last.txt',
        outputSchemaPath: '/tmp/schema.json',
        extraArgs: ['--enable', 'experimental_feature'],
      }),
    ).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--color',
      'never',
      '-C',
      '/repo',
      '--sandbox',
      'danger-full-access',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-p',
      'ci',
      '-c',
      'model="gpt-5.4"',
      '-c',
      'shell_environment_policy.inherit=all',
      '-i',
      '/tmp/a.png',
      '-i',
      '/tmp/b.png',
      '--add-dir',
      '/tmp/work',
      '-o',
      '/tmp/last.txt',
      '--output-schema',
      '/tmp/schema.json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--enable',
      'experimental_feature',
      'ship it',
    ]);
  });
});

describe('createCodexRunner', () => {
  it('spawns first turn and streams parsed events', async () => {
    let invocation: CodexExecInvocation | undefined;
    const child = new FakeChild();
    const runner = createCodexRunner({
      codexBin: '/bin/codex',
      spawn(nextInvocation) {
        invocation = nextInvocation;
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started","thread_id":"s1"}\n');
          child.stdout.write(
            '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}\n',
          );
          child.stdout.write(
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n',
          );
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 0, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({
        prompt: 'do it',
        cwd: '/tmp/repo',
        codexHome: '/tmp/codex-home',
        env: { EXTRA: '1' },
        extraEnv: { EXTRA_TWO: '2' },
      }),
    );

    expect(invocation).toMatchObject({
      bin: '/bin/codex',
      cwd: '/tmp/repo',
      args: expect.arrayContaining(['exec', '--json', '-C', '/tmp/repo', 'do it']),
    });
    expect(invocation?.env.CODEX_HOME).toBe('/tmp/codex-home');
    expect(invocation?.env.EXTRA).toBe('1');
    expect(invocation?.env.EXTRA_TWO).toBe('2');
    expect(events.map((event) => event.kind)).toEqual([
      'codex_session',
      'text_delta',
      'agent_message',
      'usage',
      'completed',
    ]);
  });

  it('spawns resumed turns with codex exec resume', async () => {
    let invocation: CodexExecInvocation | undefined;
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn(nextInvocation) {
        invocation = nextInvocation;
        setImmediate(() => {
          child.stdout.write('{"type":"turn.completed","usage":{}}\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 0, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.resumeTurn({
        codexSessionId: 's1',
        prompt: 'again',
        cwd: '/tmp/repo',
      }),
    );

    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '-C',
      '/tmp/repo',
      'resume',
      's1',
      'again',
    ]);
    expect(events).toEqual([
      { kind: 'codex_session', codexSessionId: 's1' },
      {
        kind: 'usage',
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
      expect.objectContaining({
        kind: 'completed',
        codexSessionId: 's1',
      }),
    ]);
  });

  it('does not duplicate a resumed session id when Codex also emits thread.started', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started","thread_id":"s1"}\n');
          child.stdout.write('{"type":"turn.completed","usage":{}}\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 0, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.resumeTurn({
        codexSessionId: 's1',
        prompt: 'again',
        cwd: '/tmp/repo',
      }),
    );

    expect(events.filter((event) => event.kind === 'codex_session')).toEqual([
      { kind: 'codex_session', codexSessionId: 's1' },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: 'completed',
      codexSessionId: 's1',
    });
  });

  it('fails and terminates when resume returns a different session id', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started","thread_id":"s2"}\n');
        });
        return child;
      },
    });

    const events = await collect(
      runner.resumeTurn({
        codexSessionId: 's1',
        prompt: 'again',
        cwd: '/tmp/repo',
      }),
    );

    expect(child.killed).toBe(true);
    expect(events).toEqual([
      { kind: 'codex_session', codexSessionId: 's1' },
      expect.objectContaining({
        kind: 'failed',
        code: 'resume_session_mismatch',
        codexSessionId: 's1',
        message: 'expected Codex session s1, got s2',
      }),
    ]);
  });

  it('attaches first-turn session id to terminal events after thread.started', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started","thread_id":"first-session"}\n');
          child.stdout.write('{"type":"turn.completed","usage":{}}\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 0, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'new', cwd: '/tmp/repo' }),
    );

    expect(events.at(-1)).toMatchObject({
      kind: 'completed',
      codexSessionId: 'first-session',
    });
  });

  it('includes resume session id on spawn failures', async () => {
    const runner = createCodexRunner({
      spawn() {
        throw new Error('ENOENT');
      },
    });

    const events = await collect(
      runner.resumeTurn({
        codexSessionId: 'known-session',
        prompt: 'again',
        cwd: '/tmp/repo',
      }),
    );

    expect(events).toEqual([
      {
        kind: 'failed',
        code: 'spawn_error',
        codexSessionId: 'known-session',
        message: 'spawn error: ENOENT',
      },
    ]);
  });

  it('includes resume session id when aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = createCodexRunner({
      spawn() {
        throw new Error('should not spawn');
      },
    });

    const events = await collect(
      runner.resumeTurn({
        codexSessionId: 'known-session',
        prompt: 'again',
        cwd: '/tmp/repo',
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([
      {
        kind: 'aborted',
        reason: 'signal',
        codexSessionId: 'known-session',
      },
    ]);
  });

  it('emits failed with stderr tail for non-zero exits', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stderr.write('OPENAI_API_KEY=sk-proj-secret123456789\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 2, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'fail', cwd: '/tmp/repo' }),
    );

    expect(events.at(-1)).toMatchObject({
      kind: 'failed',
      code: 'codex_exit',
      message: 'codex exit 2',
      exitCode: 2,
    });
    expect(JSON.stringify(events)).not.toContain('sk-proj-secret123456789');
  });

  it('does not append codex_exit after a streamed turn.failed terminal event', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write(
            '{"type":"turn.failed","error":{"message":"model rejected request"}}\n',
          );
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 2, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'fail in stream', cwd: '/tmp/repo' }),
    );

    expect(events).toEqual([
      {
        kind: 'failed',
        code: 'turn_failed',
        message: 'model rejected request',
      },
    ]);
  });

  it('does not append aborted after a streamed completed terminal event', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"turn.completed","usage":{}}\n');
          controller.abort();
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', null, 'SIGTERM');
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({
        prompt: 'complete before abort',
        cwd: '/tmp/repo',
        signal: controller.signal,
      }),
    );

    expect(events.map((event) => event.kind)).toEqual(['usage', 'completed']);
  });

  it('emits failed for spawn errors', async () => {
    const runner = createCodexRunner({
      spawn() {
        throw new Error('ENOENT token=abc123');
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'fail', cwd: '/tmp/repo' }),
    );

    expect(events).toEqual([
      {
        kind: 'failed',
        code: 'spawn_error',
        message: 'spawn error: ENOENT token=[REDACTED]',
      },
    ]);
  });

  it('isolates onEvent errors, emits callback_error, and kills the child', async () => {
    const child = new FakeChild();
    const callbackEvents: CodexRunnerEvent[] = [];
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started","thread_id":"s1"}\n');
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({
        prompt: 'callback throws',
        cwd: '/tmp/repo',
        onEvent(event) {
          callbackEvents.push(event);
          throw new Error('callback leaked token=abc123');
        },
      }),
    );

    expect(child.killed).toBe(true);
    expect(child.killSignals).toContain('SIGTERM');
    expect(callbackEvents).toEqual([{ kind: 'codex_session', codexSessionId: 's1' }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'failed',
      code: 'callback_error',
      message: 'onEvent callback error: callback leaked token=[REDACTED]',
    });
  });

  it('kills and emits aborted on timeout', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({ spawn: () => child });

    const events = await collect(
      runner.runTurn({ prompt: 'hang', cwd: '/tmp/repo', timeoutMs: 1 }),
    );

    expect(child.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: 'aborted',
      reason: 'timeout',
      timeoutMs: 1,
      exitSignal: 'SIGTERM',
    });
  });

  it('kills the child when the consumer stops iterating early', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({ spawn: () => child });

    const iterator = runner
      .runTurn({ prompt: 'stream', cwd: '/tmp/repo' })
      [Symbol.asyncIterator]();

    child.stdout.write('{"type":"thread.started","thread_id":"s1"}\n');
    await expect(iterator.next()).resolves.toEqual({
      value: { kind: 'codex_session', codexSessionId: 's1' },
      done: false,
    });

    await iterator.return?.();

    expect(child.killed).toBe(true);
    expect(child.killSignals).toContain('SIGTERM');
  });

  it('fails and kills the child when stdout JSONL line exceeds the configured limit', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      maxStdoutLineBytes: 8,
      spawn() {
        setImmediate(() => {
          child.stdout.write('{"type":"turn.completed"}\n');
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'too long', cwd: '/tmp/repo' }),
    );

    expect(child.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: 'failed',
      code: 'line_too_large',
      message: expect.stringContaining('Codex stdout JSONL line exceeded 8 bytes'),
    });
  });

  it('fails and kills the child when buffered events exceed the configured limit', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      maxBufferedEvents: 0,
      spawn() {
        setImmediate(() => {
          child.stdout.write(
            [
              '{"type":"thread.started","thread_id":"s1"}',
              '{"type":"turn.started"}',
              '{"type":"turn.completed","usage":{}}',
            ].join('\n') + '\n',
          );
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'overflow', cwd: '/tmp/repo' }),
    );

    expect(child.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: 'failed',
      code: 'queue_overflow',
      message: 'Codex event queue exceeded maxBufferedEvents=0',
    });
  });

  it('keeps a redacted chunk-based stderr tail without requiring newlines', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({
      spawn() {
        setImmediate(() => {
          child.stderr.write('x'.repeat(5000));
          child.stderr.write(' Bearer secret-token-without-newline');
          child.stdout.end();
          child.stderr.end();
          child.emit('exit', 2, null);
        });
        return child;
      },
    });

    const events = await collect(
      runner.runTurn({ prompt: 'fail', cwd: '/tmp/repo' }),
    );

    const failed = events.at(-1);
    expect(failed).toMatchObject({
      kind: 'failed',
      code: 'codex_exit',
    });
    expect(failed && 'stderr' in failed ? failed.stderr : '').toContain('[REDACTED]');
    expect(failed && 'stderr' in failed ? failed.stderr?.length : 0).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(events)).not.toContain('secret-token-without-newline');
  });
});
