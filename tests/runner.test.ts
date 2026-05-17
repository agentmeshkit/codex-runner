import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildCodexExecArgs,
  createCodexRunner,
  type CodexChildProcess,
  type CodexExecInvocation,
} from '../src/index.js';

class FakeChild extends EventEmitter implements CodexChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
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
  it('builds first-turn codex exec argv with cwd, model, and sandbox', () => {
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
      '--skip-git-repo-check',
      '-m',
      'gpt-5.4',
      '--sandbox',
      'read-only',
      '-C',
      '/repo',
      'inspect',
    ]);
  });

  it('builds resume argv without -C or --sandbox', () => {
    expect(
      buildCodexExecArgs(
        {
          prompt: 'continue',
          cwd: '/repo',
          sandbox: 'danger-full-access',
        },
        'session-1',
      ),
    ).toEqual([
      'exec',
      'resume',
      'session-1',
      '--json',
      '--skip-git-repo-check',
      'continue',
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

    await collect(
      runner.resumeTurn({
        codexSessionId: 's1',
        prompt: 'again',
        cwd: '/tmp/repo',
      }),
    );

    expect(invocation?.args).toEqual([
      'exec',
      'resume',
      's1',
      '--json',
      '--skip-git-repo-check',
      'again',
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
      message: 'codex exit 2',
      exitCode: 2,
    });
    expect(JSON.stringify(events)).not.toContain('sk-proj-secret123456789');
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
      { kind: 'failed', message: 'spawn error: ENOENT token=[REDACTED]' },
    ]);
  });

  it('kills and emits aborted on timeout', async () => {
    const child = new FakeChild();
    const runner = createCodexRunner({ spawn: () => child });

    const events = await collect(
      runner.runTurn({ prompt: 'hang', cwd: '/tmp/repo', timeoutMs: 1 }),
    );

    expect(child.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'aborted', reason: 'timeout' });
  });
});
