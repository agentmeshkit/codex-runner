# @agentmeshkit/codex-runner

Typed Node.js adapter for `codex exec` and `codex exec resume`.

This package is a small runtime layer around the Codex CLI. It owns process
spawning, stdout JSONL parsing, event normalization, cancellation, timeouts,
stderr tails, redaction, and resume safety checks. It is intended for apps that
want a stable event stream without binding their own code to every Codex CLI
JSONL detail.

It is not a replacement for the official Codex SDK. Use this package when you
specifically want to run the installed Codex CLI as a subprocess.

## Install

```sh
pnpm add @agentmeshkit/codex-runner
```

The host must have the `codex` CLI installed and authenticated. Authentication
is managed by Codex itself; this package only passes `CODEX_HOME` when you set
`codexHome`.

## Quick Start

```ts
import { createCodexRunner } from '@agentmeshkit/codex-runner';

const runner = createCodexRunner();

let codexSessionId: string | undefined;

for await (const event of runner.runTurn({
  prompt: 'Inspect this repo and summarize the test setup.',
  cwd: '/path/to/repo',
  sandbox: 'read-only',
  timeoutMs: 120_000,
})) {
  if (event.kind === 'codex_session') {
    codexSessionId = event.codexSessionId;
  }

  if (event.kind === 'text_delta') {
    process.stdout.write(event.text);
  }

  if (event.kind === 'failed') {
    console.error(event.code, event.message);
  }
}
```

The default `createCodexRunner()` uses `codex` from `PATH`.

```ts
const runner = createCodexRunner({
  codexBin: '/usr/local/bin/codex',
  maxStdoutLineBytes: 1024 * 1024,
  maxBufferedEvents: 1024,
  killGraceMs: 1000,
});
```

## Security Model

The runner does not relax Codex permissions by default:

- It does not pass `--sandbox` unless `request.sandbox` is set.
- It does not pass `--skip-git-repo-check` unless `request.skipGitRepoCheck` is
  `true`.
- It does not bypass approvals or sandboxing unless explicitly requested.

This means Codex CLI keeps its own configured defaults. Applications should set
permissions at the call site so reviewers can see the intended risk level.

Read-only run:

```ts
await collect(runner.runTurn({
  prompt: 'Explain the architecture.',
  cwd: '/path/to/repo',
  sandbox: 'read-only',
}));
```

Writable workspace run:

```ts
await collect(runner.runTurn({
  prompt: 'Fix the failing unit test.',
  cwd: '/path/to/repo',
  sandbox: 'workspace-write',
  approvalMode: 'on-request',
}));
```

High-permission isolated runner:

```ts
await collect(runner.runTurn({
  prompt: 'Run the full repair workflow.',
  cwd: '/path/to/repo',
  sandbox: 'danger-full-access',
  approvalMode: 'never',
  skipGitRepoCheck: true,
  dangerouslyBypassApprovalsAndSandbox: true,
}));
```

Only use high-permission settings in an externally isolated runner, VM, or
container. They are intentionally verbose so the component using the runner must
make the permission decision explicitly.

## First Turns

`runTurn()` starts a new Codex CLI session.

```ts
for await (const event of runner.runTurn({
  prompt: 'Implement the requested change and run tests.',
  cwd: '/path/to/repo',
  codexHome: '/path/to/codex-home',
  model: 'gpt-5.4',
  sandbox: 'workspace-write',
  approvalMode: 'on-request',
  images: ['/path/to/screenshot.png'],
  config: ['shell_environment_policy.inherit=all'],
  timeoutMs: 300_000,
  extraEnv: { TRACE_ID: 'turn-123' },
})) {
  sendToClient(event);
}
```

The generated command shape is:

```sh
codex exec --json --color never -C <cwd> [explicit exec options] "<prompt>"
```

If `approvalMode` is set, it is passed before `exec` because Codex exposes
`--ask-for-approval` as a top-level option:

```sh
codex --ask-for-approval never exec --json --color never -C <cwd> "<prompt>"
```

## Resume Turns

`resumeTurn()` continues an existing Codex session.

```ts
for await (const event of runner.resumeTurn({
  codexSessionId: '00000000-0000-0000-0000-000000000000',
  prompt: 'Continue from the previous turn.',
  cwd: '/path/to/repo',
  sandbox: 'workspace-write',
  timeoutMs: 300_000,
})) {
  sendToClient(event);
}
```

The generated command shape is:

```sh
codex exec --json --color never -C <cwd> [explicit exec options] resume <session_id> "<prompt>"
```

Resume safety behavior:

- `resumeTurn()` emits `codex_session` immediately using the requested
  `codexSessionId`.
- If Codex later emits the same `thread.started` id, the duplicate is
  suppressed.
- If Codex emits a different `thread.started` id, the runner emits
  `failed` with `code: 'resume_session_mismatch'` and terminates the child.
- Terminal events include `codexSessionId` when the runner knows it, including
  spawn failures and pre-spawn aborts.

Persist `codex_session.codexSessionId` from the first turn and pass it to
`resumeTurn()` for follow-up prompts.

## Request Options

`CodexTurnRequest` is the request type for `runTurn()`. `resumeTurn()` uses the
same fields plus `codexSessionId`.

| Field | Purpose |
| --- | --- |
| `prompt` | User prompt passed to Codex. Required. |
| `cwd` | Workspace root and spawned child process cwd. Required. |
| `codexHome` | Sets `CODEX_HOME` for auth/config isolation. |
| `model` | Maps to `-m, --model`. |
| `sandbox` | Maps to `--sandbox`; examples: `read-only`, `workspace-write`, `danger-full-access`. |
| `approvalMode` | Maps to top-level `--ask-for-approval`; examples: `untrusted`, `on-request`, `never`. |
| `skipGitRepoCheck` | Adds `--skip-git-repo-check` only when `true`. |
| `dangerouslyBypassApprovalsAndSandbox` | Adds Codex's dangerous bypass flag only when `true`. |
| `ephemeral` | Adds `--ephemeral`. |
| `ignoreUserConfig` | Adds `--ignore-user-config`. |
| `ignoreRules` | Adds `--ignore-rules`. |
| `profile` | Maps to `-p, --profile`. |
| `config` | Repeatable `-c key=value` overrides. |
| `images` | Repeatable `-i, --image` attachments. |
| `addDirs` | Repeatable `--add-dir` entries. |
| `outputLastMessagePath` | Maps to `-o, --output-last-message`. |
| `outputSchemaPath` | Maps to `--output-schema`. |
| `timeoutMs` | Terminates the child and emits `aborted` on timeout. |
| `signal` | External `AbortSignal`; emits `aborted` on abort. |
| `env` | Per-request environment overlay. |
| `extraEnv` | Additional per-request environment overlay, applied after `env`. |
| `onEvent` | Side-channel callback for mirroring/logging events. |
| `extraArgs` | Escape hatch appended before `resume` and the prompt. |

Use `extraArgs` for newly released Codex CLI flags that are not typed yet. It
bypasses the stable API, so keep it isolated and covered by tests in the caller.

## Runner Options

| Field | Default | Purpose |
| --- | --- | --- |
| `codexBin` | `codex` | Binary to spawn. |
| `env` | `{}` | Runner-wide environment overlay. |
| `spawn` | Node `child_process.spawn` | Test hook or custom process launcher. |
| `maxStdoutLineBytes` | `1048576` | Maximum size for one stdout JSONL line. |
| `maxBufferedEvents` | `1024` | Maximum async iterator queue length. |
| `killGraceMs` | `1000` | Time between `SIGTERM` and `SIGKILL`. |

Environment precedence is:

```txt
process.env < runner.env < request.env < request.extraEnv < request.codexHome as CODEX_HOME
```

## Event Consumption

The async iterator is the primary event stream.

```ts
for await (const event of runner.runTurn(request)) {
  switch (event.kind) {
    case 'codex_session':
      saveSessionId(event.codexSessionId);
      break;
    case 'text_delta':
      appendAssistantText(event.text);
      break;
    case 'exec_started':
      showCommand(event.command);
      break;
    case 'exec_finished':
      showCommandResult(event.ok, event.output);
      break;
    case 'completed':
      markDone(event.usage);
      break;
    case 'failed':
      showError(event.code, event.message, event.stderr);
      break;
    case 'aborted':
      showAbort(event.reason);
      break;
  }
}
```

`onEvent` is a side channel. If you use both `onEvent` and the iterator, the
same events are visible in both places. If `onEvent` throws, the runner emits a
single `failed` event with `code: 'callback_error'` on the iterator and
terminates the child without calling `onEvent` again for that synthetic failure.

If the caller breaks out of the async iterator early, the runner terminates the
Codex child process.

## Runner Events

`CodexRunnerEvent` uses a `kind` discriminator.

| Kind | Meaning |
| --- | --- |
| `codex_session` | Codex session id to persist for resume. |
| `turn_started` | Codex reported turn start. |
| `text_delta` | Incremental assistant message text. |
| `agent_message` | Full assistant message snapshot for an item. |
| `reasoning` | Reasoning summary/snapshot, with optional `delta`. |
| `file_change` | File change item. |
| `web_search` | Web search item. |
| `todo_list` | Todo list item. |
| `plan_update` | Plan update item. |
| `approval_request` | Exec or patch approval request item. |
| `tool_call` | Tool/function/MCP call snapshot. |
| `tool_result` | Tool/function/MCP result. |
| `exec_started` | Shell command started. |
| `exec_finished` | Shell command completed or failed. |
| `usage` | Token usage when Codex provides it. |
| `completed` | Terminal successful turn event. |
| `failed` | Terminal failed turn event. |
| `aborted` | Terminal local abort or timeout event. |
| `unknown` | Redacted raw payload for future Codex event types. |

`text_delta` is the ergonomic streaming event. `agent_message` is the current
full snapshot for the same message item. Callers that only need assistant text
usually consume `text_delta`.

`completed.usage` and separate `usage` events are emitted only when Codex
provides usage. Missing usage is left undefined rather than converted to zero.

## Failure Codes

`failed.code` is stable enough for caller control flow.

| Code | Meaning |
| --- | --- |
| `spawn_error` | The Codex process could not be spawned or emitted a process error. |
| `stdout_read_error` | stdout JSONL could not be read. |
| `line_too_large` | One stdout JSONL line exceeded `maxStdoutLineBytes`. |
| `queue_overflow` | The async event queue exceeded `maxBufferedEvents`. |
| `codex_exit` | Codex exited non-zero or exited by signal without a streamed terminal event. |
| `resume_session_mismatch` | Requested resume session id differed from emitted `thread.started` id. |
| `turn_failed` | Codex emitted `turn.failed`. |
| `stream_error` | Codex emitted malformed JSONL or an error event. |
| `callback_error` | Caller `onEvent` threw. |

Failure and abort events may include `stderr`, `exitCode`, `exitSignal`,
`lastEvent`, and `codexSessionId`. stderr is kept as a bounded tail and is
redacted before being surfaced.

## Capability Detection

Use `detectCodexCliCapabilities()` when an app wants a setup check before
starting a user-facing run.

```ts
import { detectCodexCliCapabilities } from '@agentmeshkit/codex-runner';

const capabilities = await detectCodexCliCapabilities({
  codexBin: 'codex',
  timeoutMs: 5000,
});

if (!capabilities.supportsJson || !capabilities.supportsResume) {
  throw new Error(
    `Codex CLI is missing required exec support: ${capabilities.warnings.join('; ')}`,
  );
}
```

The detector runs `codex --version` and `codex exec --help`. Spawn failures,
non-zero exits, and timeouts return conservative `false` capabilities with
warnings instead of throwing.

## Protocol Adapter

Use the protocol adapter when the caller wants `@agentmeshkit/protocol`-style
events with a `type` discriminator.

```ts
import {
  createCodexRunner,
  createProtocolEventMapper,
} from '@agentmeshkit/codex-runner';

const runner = createCodexRunner();
const toProtocolEvent = createProtocolEventMapper({
  turnId: 'turn-1',
  cwd: '/path/to/repo',
});

for await (const event of runner.runTurn({
  prompt: 'Inspect this repo.',
  cwd: '/path/to/repo',
  sandbox: 'read-only',
})) {
  sendToClient(toProtocolEvent(event));
}
```

The adapter maps runner events to names such as `thread_started`,
`assistant_message`, `reasoning`, `file_change`, `web_search`, `todo_list`,
`plan_update`, `approval_request`, `tool_call`, `tool_result`, `exec_begin`,
`exec_end`, `usage`, `turn_completed`, `turn_failed`, `turn_aborted`, and
`raw`.

## Redaction

Codex stdout JSONL raw payloads, stderr tails, command output, and error
messages are redacted before being emitted. OAuth tokens, API keys, bearer
tokens, passwords, cookies, sessions, and common secret environment keys are
replaced with `[REDACTED]`.

Redaction is a defense-in-depth feature, not a substitute for avoiding secrets
in prompts, command output, or logs.

## Process Safety

- `timeoutMs` emits `aborted` with `reason: 'timeout'` and `timeoutMs`.
- `signal` emits `aborted` with `reason: 'signal'`.
- Early iterator return terminates the child.
- The runner sends `SIGTERM` first and escalates to `SIGKILL` after
  `killGraceMs`.
- stdout is parsed as JSONL with a per-line byte limit.
- stderr is captured as chunks, not lines, so long warning output without
  newlines still leaves a useful tail.
- If Codex stdout already emitted `completed` or `failed`, that streamed
  terminal state wins over later process exit or abort state.

## Testing

Default tests use fixtures and fake child processes. They do not spawn a real
Codex CLI process.

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Minimal Helper

For scripts that want to collect all events:

```ts
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
```
