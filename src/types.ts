export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
  | (string & {});

export type CodexRunnerUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexRunnerEvent =
  | { kind: 'turn_started' }
  | { kind: 'codex_session'; codexSessionId: string }
  | { kind: 'text_delta'; itemId: string; text: string }
  | { kind: 'agent_message'; itemId: string; text: string; final: boolean }
  | { kind: 'reasoning'; itemId: string; text: string; final: boolean }
  | {
      kind: 'tool_call';
      toolCallId: string;
      name: string;
      arguments?: unknown;
      status?: string;
      raw?: unknown;
    }
  | {
      kind: 'tool_result';
      toolCallId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      raw?: unknown;
    }
  | {
      kind: 'exec_started';
      execId: string;
      command: string;
      status?: string;
      raw?: unknown;
    }
  | {
      kind: 'exec_finished';
      execId: string;
      command: string;
      ok: boolean;
      exitCode?: number;
      output?: string;
      status?: string;
      raw?: unknown;
    }
  | { kind: 'usage'; usage: CodexRunnerUsage }
  | { kind: 'completed'; usage?: CodexRunnerUsage; lastEvent?: CodexRunnerEvent }
  | {
      kind: 'failed';
      message: string;
      exitCode?: number | null;
      stderr?: string;
      lastEvent?: CodexRunnerEvent;
    }
  | {
      kind: 'aborted';
      reason: 'signal' | 'timeout';
      exitCode?: number | null;
      stderr?: string;
      lastEvent?: CodexRunnerEvent;
    }
  | { kind: 'unknown'; raw: unknown };

export type CodexRunnerEnvironment = Record<string, string | undefined>;

export type CodexRunnerOptions = {
  codexBin?: string;
  env?: CodexRunnerEnvironment;
  spawn?: CodexSpawnFunction;
};

export type CodexTurnRequest = {
  prompt: string;
  cwd: string;
  codexHome?: string;
  model?: string;
  sandbox?: CodexSandboxMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: CodexRunnerEnvironment;
  extraEnv?: CodexRunnerEnvironment;
  onEvent?: (event: CodexRunnerEvent) => void;
};

export type CodexResumeTurnRequest = CodexTurnRequest & {
  codexSessionId: string;
};

export type CodexExecInvocation = {
  bin: string;
  args: string[];
  cwd: string;
  env: CodexRunnerEnvironment;
};

export type CodexSpawnFunction = (
  invocation: CodexExecInvocation,
) => CodexChildProcess;

export type CodexChildProcess = {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export type CodexRunner = {
  readonly codexBin: string;
  runTurn(request: CodexTurnRequest): AsyncIterable<CodexRunnerEvent>;
  resumeTurn(request: CodexResumeTurnRequest): AsyncIterable<CodexRunnerEvent>;
};
