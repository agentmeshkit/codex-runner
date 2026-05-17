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

export type CodexRunnerErrorCode =
  | 'spawn_error'
  | 'stdout_read_error'
  | 'line_too_large'
  | 'queue_overflow'
  | 'codex_exit'
  | 'resume_session_mismatch'
  | 'turn_failed'
  | 'stream_error'
  | 'callback_error';

export type CodexApprovalMode =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | (string & {});

export type CodexRunnerEvent =
  | { kind: 'turn_started' }
  | { kind: 'codex_session'; codexSessionId: string }
  | { kind: 'text_delta'; itemId: string; text: string }
  | { kind: 'agent_message'; itemId: string; text: string; final: boolean }
  | { kind: 'reasoning'; itemId: string; text: string; delta?: string; final: boolean }
  | {
      kind: 'file_change';
      itemId: string;
      path?: string;
      status?: string;
      diff?: string;
      changes?: unknown;
      raw?: unknown;
      final: boolean;
    }
  | {
      kind: 'web_search';
      itemId: string;
      query?: string;
      status?: string;
      results?: unknown;
      raw?: unknown;
      final: boolean;
    }
  | {
      kind: 'todo_list';
      itemId: string;
      todos?: unknown;
      status?: string;
      raw?: unknown;
      final: boolean;
    }
  | {
      kind: 'plan_update';
      itemId: string;
      steps?: unknown;
      status?: string;
      raw?: unknown;
      final: boolean;
    }
  | {
      kind: 'approval_request';
      approvalId: string;
      approvalType: 'exec' | 'apply_patch' | 'unknown';
      command?: string;
      reason?: string;
      status?: string;
      raw?: unknown;
    }
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
  | {
      kind: 'completed';
      codexSessionId?: string;
      usage?: CodexRunnerUsage;
      lastEvent?: CodexRunnerEvent;
    }
  | {
      kind: 'failed';
      message: string;
      code?: CodexRunnerErrorCode;
      codexSessionId?: string;
      exitCode?: number | null;
      exitSignal?: string | null;
      stderr?: string;
      lastEvent?: CodexRunnerEvent;
    }
  | {
      kind: 'aborted';
      reason: 'signal' | 'timeout';
      codexSessionId?: string;
      timeoutMs?: number;
      exitCode?: number | null;
      exitSignal?: string | null;
      stderr?: string;
      lastEvent?: CodexRunnerEvent;
    }
  | { kind: 'unknown'; raw: unknown };

export type CodexRunnerEnvironment = Record<string, string | undefined>;

export type CodexRunnerOptions = {
  codexBin?: string;
  env?: CodexRunnerEnvironment;
  spawn?: CodexSpawnFunction;
  maxStdoutLineBytes?: number;
  maxBufferedEvents?: number;
  killGraceMs?: number;
};

export type CodexTurnRequest = {
  prompt: string;
  cwd: string;
  codexHome?: string;
  model?: string;
  sandbox?: CodexSandboxMode;
  approvalMode?: CodexApprovalMode;
  skipGitRepoCheck?: boolean;
  ephemeral?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  profile?: string;
  config?: string[];
  images?: string[];
  addDirs?: string[];
  outputLastMessagePath?: string;
  outputSchemaPath?: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  extraArgs?: string[];
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
