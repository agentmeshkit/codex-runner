# @agentmeshkit/codex-runner

Node runtime wrapper for `codex exec` and `codex exec resume`.

This package owns process spawning, JSONL normalization, cancellation, timeouts,
and stream events for Codex-backed agent applications.

## Install

```sh
pnpm add @agentmeshkit/codex-runner
```

## First Turn

```ts
import { createCodexRunner } from '@agentmeshkit/codex-runner';

const runner = createCodexRunner({
  codexBin: 'codex',
  maxStdoutLineBytes: 1024 * 1024,
  maxBufferedEvents: 1024,
  killGraceMs: 1000,
});

for await (const event of runner.runTurn({
  prompt: 'Inspect this repo and summarize the test setup.',
  cwd: '/path/to/repo',
  codexHome: '/path/to/codex-home',
  model: 'gpt-5.4',
  sandbox: 'workspace-write',
  timeoutMs: 120_000,
  env: { FEATURE_FLAG: '1' },
  extraEnv: { TRACE_ID: 'turn-1' },
})) {
  if (event.kind === 'codex_session') {
    console.log('resume with', event.codexSessionId);
  }
  if (event.kind === 'completed' && event.codexSessionId) {
    console.log('last known session', event.codexSessionId);
  }
}
```

## Resume

```ts
for await (const event of runner.resumeTurn({
  codexSessionId: '00000000-0000-0000-0000-000000000000',
  prompt: 'Continue from the previous turn.',
  cwd: '/path/to/repo',
  codexHome: '/path/to/codex-home',
})) {
  sendToClient(event);
}
```

Resume uses `codex exec resume <codex_session_id> --json ...` and sets the
Node child process `cwd`; Codex session metadata owns the original sandbox.
Because resumed sessions already have a known id, `resumeTurn()` emits
`codex_session` immediately even if the Codex CLI does not repeat
`thread.started` on stdout.

## CLI Capability Detection

Use `detectCodexCliCapabilities` before starting user-facing work when the app
needs a clearer setup error than a later Codex subprocess failure:

```ts
import { detectCodexCliCapabilities } from '@agentmeshkit/codex-runner';

const capabilities = await detectCodexCliCapabilities({ codexBin: 'codex' });

if (!capabilities.supportsJson || !capabilities.supportsResume) {
  console.warn('Codex CLI is missing required exec support', capabilities.warnings);
}
```

The detector runs `codex --version` and `codex exec --help` with a timeout. CLI
spawn failures, non-zero exits, and timeouts return conservative `false`
capabilities plus warnings instead of throwing.

## Events

The runner's default stream emits local events with a `kind` discriminator.
This preserves the stable `CodexRunnerEvent` API used by existing tests and
callers:

- `codex_session`, `turn_started`
- `text_delta`, `agent_message`, `reasoning`
- `file_change`, `web_search`, `todo_list`, `approval_request`
- `tool_call`, `tool_result`
- `exec_started`, `exec_finished`
- `usage`, `completed`, `failed`, `aborted`, `unknown`

For continuous sessions, use `codex_session` as the primary source of the
resume id. Terminal events (`completed`, `failed`, and `aborted`) also include
`codexSessionId` when the runner knows it, so callers can persist the id even if
they only inspect the final event. On resume, that id is available even when
process spawn fails or the turn is aborted before Codex writes JSONL.

`failed` events include `message` and may include a stable `code` such as
`spawn_error`, `stdout_read_error`, `line_too_large`, `queue_overflow`,
`codex_exit`, `turn_failed`, `stream_error`, or `callback_error`.

Use the protocol adapter when the caller needs `@agentmeshkit/protocol`-style
events with a `type` discriminator:

```ts
import { createCodexRunner, createProtocolEventMapper } from '@agentmeshkit/codex-runner';

const runner = createCodexRunner();
const toProtocolEvent = createProtocolEventMapper({
  turnId: 'turn-1',
  cwd: '/path/to/repo',
});

for await (const event of runner.runTurn({
  prompt: 'Inspect this repo.',
  cwd: '/path/to/repo',
})) {
  sendToClient(toProtocolEvent(event));
}
```

The adapter maps runner events to protocol-compatible event names such as
`thread_started`, `assistant_message`, `reasoning`, `file_change`,
`web_search`, `todo_list`, `approval_request`, `tool_call`, `tool_result`,
`exec_begin`, `exec_end`, `usage`, `turn_completed`, `turn_failed`, and
`turn_aborted`. It intentionally defines a minimal compatible type surface
inside this package instead of depending on the currently published
`@agentmeshkit/protocol` package. After protocol is published with the desired
contract, this adapter can be switched to import those types directly.

Codex CLI stdout JSONL and stderr are redacted before they are surfaced through
events. OAuth tokens, API keys, passwords, bearer tokens, and common secret
environment keys are replaced with `[REDACTED]`.

## Process and Stream Safety

The runner terminates the Codex child process when a turn is aborted, times out,
or when the caller stops consuming the async iterator early. It sends `SIGTERM`
first and escalates to `SIGKILL` after `killGraceMs`.

`maxStdoutLineBytes` bounds each stdout JSONL line. If Codex emits a malformed or
oversized line, the runner emits a `failed` event and terminates the child
process. `maxBufferedEvents` bounds the async event queue; overflow also fails
the turn and terminates the child. Both limits are runner-level options.

`onEvent` callbacks are isolated from the runner. If a callback throws, the
runner emits a `failed` event with `code: 'callback_error'` without recursively
calling the same callback for that synthetic failure, then terminates the child
process.

If Codex stdout already emits a terminal `completed` or `failed` event, that
stream terminal state wins. A later non-zero process exit or abort signal is not
reported as a second terminal event.

## Tests

Default tests use fixtures and fake child processes; they do not spawn a real
Codex CLI process.

```sh
pnpm build
pnpm typecheck
pnpm test
```
