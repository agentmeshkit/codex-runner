# PRD: AgentMeshKit Codex Runner

## Summary

`@agentmeshkit/codex-runner` wraps the Codex CLI as a reusable Node package. It
turns `codex exec` and `codex exec resume` into a typed, observable runtime that
multiple apps can share.

## Problem

AgentWeb currently embeds Codex process management directly in the app:
spawning, resuming, parsing JSONL, handling `command_execution`, surfacing tool
events, storing session ids, and managing failures. Other projects will need
the same behavior.

## Users

- Backend services that run Codex as an agent subprocess.
- Desktop or LAN apps that need resumable coding-agent sessions.
- Test harnesses that need deterministic runner fixtures.

## Goals

- Provide one reliable wrapper around Codex CLI execution.
- Normalize Codex JSONL into stable runner-local events, with an adapter for
  `@agentmeshkit/protocol`-style events.
- Support first turn, resumed turns, cancellation, timeout, and process exit
  diagnostics.
- Bound stdout JSONL lines and queued events so malformed CLI output or slow
  consumers cannot grow memory without limit.
- Clean up the Codex child process when callers stop consuming a stream early.
- Detect installed Codex CLI capabilities before a turn when callers want setup
  diagnostics.
- Isolate caller `onEvent` callback failures from the runner lifecycle.
- Return or preserve the Codex session id reliably for continuous conversation
  flows.
- Keep terminal event semantics single-source: if the Codex JSONL stream already
  emitted `completed` or `failed`, later process exit state must not append a
  second terminal event.
- Keep authentication external through `codexHome`.

## Non-Goals

- No UI.
- No OAuth refresh implementation.
- No workspace file uploads.
- No business workflow orchestration.

## MVP Scope

- `createCodexRunner(options)`.
- `runTurn({ prompt, cwd, model, sandbox, codexHome })`.
- `resumeTurn({ codexSessionId, prompt, cwd, model, codexHome })`.
- Async iterable or callback stream of normalized events.
- Codex CLI 0.130+ `command_execution` support.
- Structured failure result with exit code, stderr tail, and last event.
- `timeoutMs`, `AbortSignal`, and extra environment support.
- Secret redaction for emitted raw events, stderr tails, and error messages.
- `maxStdoutLineBytes`, `maxBufferedEvents`, and `killGraceMs` runner options.
- Explicit parser support for `file_change`, `web_search`, `todo_list`, and
  approval request items.
- `detectCodexCliCapabilities()` for conservative `codex --version` and
  `codex exec --help` probing.
- Stable optional `failed.code` values for runner and parser failure modes.
- `codexSessionId` on terminal events when known; `resumeTurn()` emits a
  synthetic `codex_session` event from the requested resume id before waiting
  for CLI stdout.

## Public API Sketch

```ts
const runner = createCodexRunner({ codexBin: 'codex' });

for await (const event of runner.runTurn({
  prompt: 'Inspect this repo',
  cwd: '/repo',
  codexHome: '/accounts/default',
  model: 'gpt-5.4',
})) {
  send(event);
}
```

Resume:

```ts
for await (const event of runner.resumeTurn({
  codexSessionId,
  prompt: 'Continue',
  cwd: '/repo',
  codexHome: '/accounts/default',
})) {
  send(event);
}
```

Implemented command shape:

- First turn: `codex exec --json --skip-git-repo-check [-m model] --sandbox <sandbox> -C <cwd> <prompt>`
- Resume: `codex exec resume <codex_session_id> --json --skip-git-repo-check [-m model] <prompt>`

The resume path still sets the spawned child process `cwd`, but does not pass
`-C` or `--sandbox` because current Codex resume inherits those from session
metadata.

For continuous sessions, callers should persist the value from `codex_session`.
Terminal events (`completed`, `failed`, and `aborted`) also include
`codexSessionId` when available. On `resumeTurn()`, the runner already knows the
session id supplied by the caller, so it emits `codex_session` even if the CLI
does not repeat `thread.started`.

Implemented default runner events use a `kind` discriminator:

- `codex_session`, `turn_started`
- `text_delta`, `agent_message`, `reasoning`
- `file_change`, `web_search`, `todo_list`, `approval_request`
- `tool_call`, `tool_result`
- `exec_started`, `exec_finished`
- `usage`, `completed`, `failed`, `aborted`, `unknown`

Implemented `failed.code` values include `spawn_error`, `stdout_read_error`,
`line_too_large`, `queue_overflow`, `codex_exit`, `turn_failed`,
`stream_error`, and `callback_error`.

Capability detection:

```ts
const capabilities = await detectCodexCliCapabilities({ codexBin: 'codex' });
```

The detector returns conservative unsupported capabilities with warnings on
spawn errors, command failures, or timeout. It throws only for invalid caller
options.

Protocol-style events are opt-in through `toAgentStreamEvent(event, context)` or
`createProtocolEventMapper(context)`. The adapter emits a `type` discriminator
and protocol-compatible event names, including `thread_started`,
`assistant_message`, `reasoning`, `file_change`, `web_search`, `todo_list`,
`approval_request`, `tool_call`, `tool_result`, `exec_begin`, `exec_end`,
`usage`, `turn_completed`, `turn_failed`, and `turn_aborted`.

The package currently defines a minimal compatible protocol event type surface
locally instead of depending on a published `@agentmeshkit/protocol` package.
Once protocol is published with the required contract, the adapter can switch to
direct type imports without changing the default `CodexRunnerEvent` stream.

## Acceptance Criteria

- Unit tests cover first turn, resume, command execution, text deltas, failed
  turns, process errors, adapter mappings, and resumed-turn abort mappings.
- Unit tests cover early async-iterator break cleanup, oversized stdout JSONL
  failure, event queue overflow failure, and newly normalized Codex item types.
- Unit tests cover capability detection, callback failure isolation, and stable
  failure codes.
- Unit tests cover resume session id emission, duplicate session id suppression,
  terminal event session id fallback, and compatible `thread.started` id field
  names.
- Unit tests cover stream terminal events winning over later process exit or
  abort state.
- Fixture tests replay real Codex JSONL without spawning Codex.
- No secrets are logged.
- The package can be used without AgentWeb.
- Default test suite does not require a logged-in Codex CLI.

## Milestones

1. Extract event parser fixtures from AgentWeb.
2. Implement runner API around child process.
3. Add cancellation and timeout tests.
4. Publish `0.1.0`.
