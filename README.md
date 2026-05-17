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

const runner = createCodexRunner({ codexBin: 'codex' });

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

## Events

The runner's default stream emits local events with a `kind` discriminator.
This preserves the stable `CodexRunnerEvent` API used by existing tests and
callers:

- `codex_session`, `turn_started`
- `text_delta`, `agent_message`, `reasoning`
- `tool_call`, `tool_result`
- `exec_started`, `exec_finished`
- `usage`, `completed`, `failed`, `aborted`, `unknown`

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
`thread_started`, `assistant_message`, `reasoning`, `tool_call`,
`tool_result`, `exec_begin`, `exec_end`, `usage`, `turn_completed`,
`turn_failed`, and `turn_aborted`. It intentionally defines a minimal compatible
type surface inside this package instead of depending on the currently published
`@agentmeshkit/protocol` package. After protocol is published with the desired
contract, this adapter can be switched to import those types directly.

Codex CLI stdout JSONL and stderr are redacted before they are surfaced through
events. OAuth tokens, API keys, passwords, bearer tokens, and common secret
environment keys are replaced with `[REDACTED]`.

## Tests

Default tests use fixtures and fake child processes; they do not spawn a real
Codex CLI process.

```sh
pnpm build
pnpm typecheck
pnpm test
```
