import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CodexJsonlParser } from './parser.js';
import { redactString } from './redact.js';
import type {
  CodexChildProcess,
  CodexExecInvocation,
  CodexResumeTurnRequest,
  CodexRunner,
  CodexRunnerEnvironment,
  CodexRunnerErrorCode,
  CodexRunnerEvent,
  CodexRunnerOptions,
  CodexSpawnFunction,
  CodexTurnRequest,
} from './types.js';

const DEFAULT_CODEX_BIN = 'codex';
const STDERR_TAIL_LIMIT = 4000;
const DEFAULT_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_EVENTS = 1024;
const DEFAULT_KILL_GRACE_MS = 1000;

export function createCodexRunner(options: CodexRunnerOptions = {}): CodexRunner {
  const codexBin = options.codexBin ?? DEFAULT_CODEX_BIN;
  const spawnFn = options.spawn ?? defaultSpawn;
  const defaultEnv = options.env ?? {};
  const maxStdoutLineBytes = options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    codexBin,
    runTurn(request: CodexTurnRequest): AsyncIterable<CodexRunnerEvent> {
      return runCodexExec({
        request,
        codexBin,
        defaultEnv,
        spawnFn,
        maxStdoutLineBytes,
        maxBufferedEvents,
        killGraceMs,
      });
    },
    resumeTurn(request: CodexResumeTurnRequest): AsyncIterable<CodexRunnerEvent> {
      return runCodexExec({
        request,
        codexBin,
        defaultEnv,
        spawnFn,
        codexSessionId: request.codexSessionId,
        maxStdoutLineBytes,
        maxBufferedEvents,
        killGraceMs,
      });
    },
  };
}

export function buildCodexExecArgs(
  request: CodexTurnRequest,
  codexSessionId?: string,
): string[] {
  const args: string[] = [];
  if (request.approvalMode) args.push('--ask-for-approval', request.approvalMode);

  args.push('exec', '--json', '--color', 'never');
  if (request.model) args.push('-m', request.model);
  if (request.cwd) args.push('-C', request.cwd);
  if (request.sandbox) args.push('--sandbox', request.sandbox);
  if (request.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (request.ephemeral) args.push('--ephemeral');
  if (request.ignoreUserConfig) args.push('--ignore-user-config');
  if (request.ignoreRules) args.push('--ignore-rules');
  if (request.profile) args.push('-p', request.profile);
  for (const config of request.config ?? []) args.push('-c', config);
  for (const image of request.images ?? []) args.push('-i', image);
  for (const addDir of request.addDirs ?? []) args.push('--add-dir', addDir);
  if (request.outputLastMessagePath) args.push('-o', request.outputLastMessagePath);
  if (request.outputSchemaPath) args.push('--output-schema', request.outputSchemaPath);
  if (request.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push(...(request.extraArgs ?? []));
  if (codexSessionId) {
    args.push('resume', codexSessionId);
  }
  args.push(request.prompt);
  return args;
}

type RunCodexExecOptions = {
  request: CodexTurnRequest;
  codexBin: string;
  defaultEnv: CodexRunnerEnvironment;
  spawnFn: CodexSpawnFunction;
  codexSessionId?: string;
  maxStdoutLineBytes: number;
  maxBufferedEvents: number;
  killGraceMs: number;
};

async function* runCodexExec(
  options: RunCodexExecOptions,
): AsyncIterable<CodexRunnerEvent> {
  const { request } = options;
  if (request.signal?.aborted) {
    yield emitBeforeChild(request, {
      kind: 'aborted',
      reason: 'signal',
      codexSessionId: options.codexSessionId,
    });
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
    yield emitBeforeChild(request, {
      kind: 'failed',
      code: 'spawn_error',
      codexSessionId: options.codexSessionId,
      message: `spawn error: ${redactString(errorMessage(error))}`,
    });
    return;
  }

  const parser = new CodexJsonlParser();
  let stderr = '';
  let abortedReason: 'signal' | 'timeout' | undefined;
  let completedOrFailedInStream = false;
  let terminalEventInStream: 'completed' | 'failed' | undefined;
  let childExited = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let knownCodexSessionId = options.codexSessionId;
  let emittedCodexSessionId: string | undefined;

  const terminateChild = (signal: NodeJS.Signals = 'SIGTERM') => {
    try {
      child.kill(signal);
    } catch {
      // Nothing useful to surface here; exit/error handling reports the final state.
    }
    if (signal !== 'SIGKILL' && !forceKillTimer && options.killGraceMs > 0) {
      forceKillTimer = setTimeout(() => terminateChild('SIGKILL'), options.killGraceMs);
      forceKillTimer.unref?.();
    }
  };

  const abort = (reason: 'signal' | 'timeout') => {
    if (abortedReason) return;
    abortedReason = reason;
    terminateChild('SIGTERM');
  };

  const abortListener = () => abort('signal');
  request.signal?.addEventListener('abort', abortListener, { once: true });
  const timeout = request.timeoutMs
    ? setTimeout(() => abort('timeout'), request.timeoutMs)
    : undefined;

  const eventQueue = new AsyncEventQueue<CodexRunnerEvent>(options.maxBufferedEvents);
  let callbackFailed = false;

  const failedEvent = (
    code: CodexRunnerErrorCode,
    message: string,
    extra: Partial<Extract<CodexRunnerEvent, { kind: 'failed' }>> = {},
  ): Extract<CodexRunnerEvent, { kind: 'failed' }> => ({
    kind: 'failed',
    code,
    codexSessionId: knownCodexSessionId,
    message,
    stderr: stderr ? redactString(stderr) : undefined,
    lastEvent: parser.lastEvent,
    ...extra,
  });

  const failAndTerminate = (code: CodexRunnerErrorCode, message: string) => {
    completedOrFailedInStream = true;
    const emitted = emitSafe(failedEvent(code, message));
    if (emitted) eventQueue.fail(emitted);
    terminateChild('SIGTERM');
  };

  const failForCallbackError = (error: unknown) => {
    if (callbackFailed) return;
    callbackFailed = true;
    completedOrFailedInStream = true;
    eventQueue.fail(
      enrichWithSession(
        failedEvent(
          'callback_error',
          `onEvent callback error: ${redactString(errorMessage(error))}`,
        ),
      ),
    );
    terminateChild('SIGTERM');
  };

  const emitSafe = (event: CodexRunnerEvent): CodexRunnerEvent | undefined => {
    if (callbackFailed) return undefined;
    try {
      request.onEvent?.(event);
      if (event.kind === 'codex_session') emittedCodexSessionId = event.codexSessionId;
      return event;
    } catch (error) {
      failForCallbackError(error);
      return undefined;
    }
  };

  const pushRunnerEvent = (event: CodexRunnerEvent): boolean => {
    if (eventQueue.closed) return false;
    const prepared = prepareEvent(event);
    if (!prepared) return !eventQueue.closed;
    const emitted = emitSafe(prepared);
    if (!emitted) return false;
    const pushed = eventQueue.push(emitted);
    if (!pushed) {
      failAndTerminate(
        'queue_overflow',
        `Codex event queue exceeded maxBufferedEvents=${options.maxBufferedEvents}`,
      );
      return false;
    }
    return true;
  };

  const prepareEvent = (event: CodexRunnerEvent): CodexRunnerEvent | undefined => {
    if (event.kind === 'codex_session') {
      if (
        options.codexSessionId &&
        event.codexSessionId !== options.codexSessionId
      ) {
        failAndTerminate(
          'resume_session_mismatch',
          `expected Codex session ${options.codexSessionId}, got ${event.codexSessionId}`,
        );
        return undefined;
      }
      knownCodexSessionId = event.codexSessionId;
      if (emittedCodexSessionId === event.codexSessionId) return undefined;
      return event;
    }
    return enrichWithSession(event);
  };

  const enrichWithSession = (event: CodexRunnerEvent): CodexRunnerEvent => {
    if (!knownCodexSessionId) return event;
    switch (event.kind) {
      case 'completed':
        return { ...event, codexSessionId: event.codexSessionId ?? knownCodexSessionId };
      case 'failed':
        return { ...event, codexSessionId: event.codexSessionId ?? knownCodexSessionId };
      case 'aborted':
        return { ...event, codexSessionId: event.codexSessionId ?? knownCodexSessionId };
      default:
        return event;
    }
  };

  if (options.codexSessionId) {
    pushRunnerEvent({ kind: 'codex_session', codexSessionId: options.codexSessionId });
  }

  const stdoutPump = pumpStream(
    child.stdout,
    (chunk) => {
      for (const event of parser.parseLine(chunk)) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          completedOrFailedInStream = true;
          terminalEventInStream ??= event.kind;
        }
        if (!pushRunnerEvent(event)) break;
      }
    },
    { maxLineBytes: options.maxStdoutLineBytes, streamName: 'Codex stdout JSONL' },
  ).catch((error) => {
    failAndTerminate(
      error instanceof LineTooLargeError ? 'line_too_large' : 'stdout_read_error',
      `stdout read error: ${redactString(errorMessage(error))}`,
    );
  });

  const stderrPump = pumpStderr(
    child.stderr,
    (chunk) => {
      stderr = tail(`${stderr}${chunk}`, STDERR_TAIL_LIMIT);
    },
  ).catch((error) => {
    stderr = tail(
      `${stderr}\nstderr read error: ${errorMessage(error)}`,
      STDERR_TAIL_LIMIT,
    );
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
    childExited = true;
    request.signal?.removeEventListener('abort', abortListener);
    if (timeout) clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);

    if (eventQueue.closed) return;

    if (result.type === 'error') {
      pushRunnerEvent(
        failedEvent('spawn_error', `spawn error: ${redactString(result.error.message)}`),
      );
      eventQueue.close();
      return;
    }

    await Promise.allSettled([stdoutPump, stderrPump]);

    if (terminalEventInStream) {
      eventQueue.close();
      return;
    }

    if (abortedReason) {
      pushRunnerEvent({
        kind: 'aborted',
        reason: abortedReason,
        timeoutMs: abortedReason === 'timeout' ? request.timeoutMs : undefined,
        exitCode: result.code,
        exitSignal: result.signal,
        stderr: stderr ? redactString(stderr) : undefined,
        lastEvent: parser.lastEvent,
      });
      eventQueue.close();
      return;
    }

    if (result.code !== 0 && result.code !== null) {
      pushRunnerEvent(
        failedEvent('codex_exit', `codex exit ${result.code}`, {
          exitCode: result.code,
          exitSignal: result.signal,
        }),
      );
      eventQueue.close();
      return;
    }

    if (result.signal) {
      pushRunnerEvent(
        failedEvent('codex_exit', `codex exited with signal ${result.signal}`, {
          exitCode: result.code,
          exitSignal: result.signal,
        }),
      );
      eventQueue.close();
      return;
    }

    if (!completedOrFailedInStream) {
      pushRunnerEvent({ kind: 'completed', lastEvent: parser.lastEvent });
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
    if (!childExited && !eventQueue.closed) {
      eventQueue.close();
      terminateChild('SIGTERM');
    }
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
  options: { maxLineBytes?: number; streamName?: string } = {},
): Promise<void> {
  if (!stream) return;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream as Readable) {
    buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      assertLineWithinLimit(line, options);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) onLine(line);
    }
    assertLineWithinLimit(buffer, options);
  }
  const tail = decoder.end();
  if (tail) {
    buffer += tail;
    assertLineWithinLimit(buffer, options);
  }
  if (buffer.trim()) onLine(buffer);
}

async function pumpStderr(
  stream: NodeJS.ReadableStream | null | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream as Readable) {
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (text) onChunk(text);
  }
  const tail = decoder.end();
  if (tail) onChunk(tail);
}

function assertLineWithinLimit(
  line: string,
  options: { maxLineBytes?: number; streamName?: string },
): void {
  if (!options.maxLineBytes) return;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > options.maxLineBytes) {
    throw new LineTooLargeError(
      `${options.streamName ?? 'stream'} line exceeded ${options.maxLineBytes} bytes`,
    );
  }
}

class LineTooLargeError extends Error {}

function emitBeforeChild(
  request: CodexTurnRequest,
  event: CodexRunnerEvent,
): CodexRunnerEvent {
  try {
    request.onEvent?.(event);
    return event;
  } catch (error) {
    return {
      kind: 'failed',
      code: 'callback_error',
      codexSessionId: terminalCodexSessionId(event),
      message: `onEvent callback error: ${redactString(errorMessage(error))}`,
      lastEvent: event,
    };
  }
}

function terminalCodexSessionId(event: CodexRunnerEvent): string | undefined {
  switch (event.kind) {
    case 'completed':
    case 'failed':
    case 'aborted':
      return event.codexSessionId;
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private isClosed = false;

  constructor(private readonly maxBufferedEvents: number) {}

  get closed(): boolean {
    return this.isClosed;
  }

  push(value: T): boolean {
    if (this.isClosed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return true;
    }
    if (this.values.length >= this.maxBufferedEvents) return false;
    this.values.push(value);
    return true;
  }

  fail(value: T): void {
    if (this.isClosed) return;
    this.values.length = 0;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
    this.close();
  }

  close(): void {
    if (this.isClosed) return;
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
