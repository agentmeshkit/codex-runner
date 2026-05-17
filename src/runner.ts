import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { CodexJsonlParser } from './parser.js';
import { redactString } from './redact.js';
import type {
  CodexChildProcess,
  CodexExecInvocation,
  CodexResumeTurnRequest,
  CodexRunner,
  CodexRunnerEnvironment,
  CodexRunnerEvent,
  CodexRunnerOptions,
  CodexSpawnFunction,
  CodexTurnRequest,
} from './types.js';

const DEFAULT_CODEX_BIN = 'codex';
const DEFAULT_SANDBOX = 'workspace-write';
const STDERR_TAIL_LIMIT = 4000;

export function createCodexRunner(options: CodexRunnerOptions = {}): CodexRunner {
  const codexBin = options.codexBin ?? DEFAULT_CODEX_BIN;
  const spawnFn = options.spawn ?? defaultSpawn;
  const defaultEnv = options.env ?? {};

  return {
    codexBin,
    runTurn(request: CodexTurnRequest): AsyncIterable<CodexRunnerEvent> {
      return runCodexExec({
        request,
        codexBin,
        defaultEnv,
        spawnFn,
      });
    },
    resumeTurn(request: CodexResumeTurnRequest): AsyncIterable<CodexRunnerEvent> {
      return runCodexExec({
        request,
        codexBin,
        defaultEnv,
        spawnFn,
        codexSessionId: request.codexSessionId,
      });
    },
  };
}

export function buildCodexExecArgs(
  request: CodexTurnRequest,
  codexSessionId?: string,
): string[] {
  const common = ['--json', '--skip-git-repo-check'];
  if (request.model) common.push('-m', request.model);

  if (codexSessionId) {
    return ['exec', 'resume', codexSessionId, ...common, request.prompt];
  }

  return [
    'exec',
    ...common,
    '--sandbox',
    request.sandbox ?? DEFAULT_SANDBOX,
    '-C',
    request.cwd,
    request.prompt,
  ];
}

type RunCodexExecOptions = {
  request: CodexTurnRequest;
  codexBin: string;
  defaultEnv: CodexRunnerEnvironment;
  spawnFn: CodexSpawnFunction;
  codexSessionId?: string;
};

async function* runCodexExec(
  options: RunCodexExecOptions,
): AsyncIterable<CodexRunnerEvent> {
  const { request } = options;
  if (request.signal?.aborted) {
    yield emit(request, { kind: 'aborted', reason: 'signal' });
    return;
  }

  const invocation: CodexExecInvocation = {
    bin: options.codexBin,
    args: buildCodexExecArgs(request, options.codexSessionId),
    cwd: request.cwd,
    env: buildEnvironment(options.defaultEnv, request),
  };

  let child: CodexChildProcess;
  try {
    child = options.spawnFn(invocation);
  } catch (error) {
    yield emit(request, {
      kind: 'failed',
      message: `spawn error: ${redactString((error as Error).message)}`,
    });
    return;
  }

  const parser = new CodexJsonlParser();
  let stderr = '';
  let abortedReason: 'signal' | 'timeout' | undefined;
  let completedOrFailedInStream = false;

  const abort = (reason: 'signal' | 'timeout') => {
    if (abortedReason) return;
    abortedReason = reason;
    child.kill('SIGTERM');
  };

  const abortListener = () => abort('signal');
  request.signal?.addEventListener('abort', abortListener, { once: true });
  const timeout = request.timeoutMs
    ? setTimeout(() => abort('timeout'), request.timeoutMs)
    : undefined;

  const eventQueue = new AsyncEventQueue<CodexRunnerEvent>();

  const stdoutPump = pumpStream(child.stdout, (chunk) => {
    for (const event of parser.parseLine(chunk)) {
      if (event.kind === 'completed' || event.kind === 'failed') {
        completedOrFailedInStream = true;
      }
      eventQueue.push(emit(request, event));
    }
  }).catch((error) => {
    eventQueue.push(
      emit(request, {
        kind: 'failed',
        message: `stdout read error: ${redactString((error as Error).message)}`,
        lastEvent: parser.lastEvent,
      }),
    );
    completedOrFailedInStream = true;
  });

  const stderrPump = pumpStream(child.stderr, (chunk) => {
    stderr = tail(`${stderr}${chunk}`, STDERR_TAIL_LIMIT);
  }).catch((error) => {
    stderr = tail(`${stderr}\nstderr read error: ${(error as Error).message}`, STDERR_TAIL_LIMIT);
  });

  const exitPromise = Promise.race([
    new Promise<{ type: 'exit'; code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ type: 'exit', code, signal }));
      },
    ),
    new Promise<{ type: 'error'; error: Error }>((resolve) => {
      child.once('error', (error) => resolve({ type: 'error', error }));
    }),
  ]);

  void exitPromise.then(async (result) => {
    request.signal?.removeEventListener('abort', abortListener);
    if (timeout) clearTimeout(timeout);

    if (result.type === 'error') {
      eventQueue.push(
        emit(request, {
          kind: 'failed',
          message: `spawn error: ${redactString(result.error.message)}`,
          stderr: stderr ? redactString(stderr) : undefined,
          lastEvent: parser.lastEvent,
        }),
      );
      eventQueue.close();
      return;
    }

    await Promise.allSettled([stdoutPump, stderrPump]);

    if (abortedReason) {
      eventQueue.push(
        emit(request, {
          kind: 'aborted',
          reason: abortedReason,
          exitCode: result.code,
          stderr: stderr ? redactString(stderr) : undefined,
          lastEvent: parser.lastEvent,
        }),
      );
      eventQueue.close();
      return;
    }

    if (result.code !== 0 && result.code !== null) {
      eventQueue.push(
        emit(request, {
          kind: 'failed',
          message: `codex exit ${result.code}`,
          exitCode: result.code,
          stderr: stderr ? redactString(stderr) : undefined,
          lastEvent: parser.lastEvent,
        }),
      );
      eventQueue.close();
      return;
    }

    if (!completedOrFailedInStream) {
      eventQueue.push(emit(request, { kind: 'completed', lastEvent: parser.lastEvent }));
    }
    eventQueue.close();
  });

  try {
    for await (const event of eventQueue) {
      yield event;
    }
  } finally {
    request.signal?.removeEventListener('abort', abortListener);
    if (timeout) clearTimeout(timeout);
  }
}

function defaultSpawn(invocation: CodexExecInvocation): CodexChildProcess {
  return nodeSpawn(invocation.bin, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildEnvironment(
  defaultEnv: CodexRunnerEnvironment,
  request: CodexTurnRequest,
): CodexRunnerEnvironment {
  const env: CodexRunnerEnvironment = {
    ...(process.env as CodexRunnerEnvironment),
    ...defaultEnv,
    ...(request.env ?? {}),
    ...(request.extraEnv ?? {}),
  };
  if (request.codexHome) env.CODEX_HOME = request.codexHome;
  return env;
}

async function pumpStream(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  let buffer = '';
  for await (const chunk of stream as Readable) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer);
}

function emit(request: CodexTurnRequest, event: CodexRunnerEvent): CodexRunnerEvent {
  request.onEvent?.(event);
  return event;
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private isClosed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.isClosed = true;
    let waiter: ((result: IteratorResult<T>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.isClosed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
