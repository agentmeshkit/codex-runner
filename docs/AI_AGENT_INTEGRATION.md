# AI Agent Integration

Use this file as the minimal context for integrating
`@agentmeshkit/codex-runner`.

## Install

```ts
import { createCodexRunner } from '@agentmeshkit/codex-runner';
import type { CodexRunnerEvent } from '@agentmeshkit/codex-runner';
```

The host must have an authenticated `codex` CLI. Set `codexHome` only when the
caller needs a specific `CODEX_HOME`.

## Required Rule

Do not rely on implicit permissions. The component calling this package must
explicitly choose permissions per turn.

Safe read-only:

```ts
sandbox: 'read-only'
```

Writable repo:

```ts
sandbox: 'workspace-write',
approvalMode: 'on-request'
```

Isolated high-permission runner only:

```ts
sandbox: 'danger-full-access',
approvalMode: 'never',
skipGitRepoCheck: true,
dangerouslyBypassApprovalsAndSandbox: true
```

The runner does not add `--sandbox` or `--skip-git-repo-check` unless the
request sets them.

## First Turn

```ts
const runner = createCodexRunner();

for await (const event of runner.runTurn({
  prompt: 'Inspect the repo and summarize what to change.',
  cwd: '/path/to/repo',
  sandbox: 'read-only',
  timeoutMs: 120_000,
})) {
  handleEvent(event);
}
```

Command shape:

```sh
codex exec --json --color never -C <cwd> [explicit options] "<prompt>"
```

## Resume Turn

Persist `codex_session.codexSessionId` from the first turn.

```ts
for await (const event of runner.resumeTurn({
  codexSessionId,
  prompt: 'Continue with the implementation.',
  cwd: '/path/to/repo',
  sandbox: 'workspace-write',
  approvalMode: 'on-request',
  timeoutMs: 300_000,
})) {
  handleEvent(event);
}
```

Command shape:

```sh
codex exec --json --color never -C <cwd> [explicit options] resume <session_id> "<prompt>"
```

If Codex emits a different `thread.started` id during resume, the runner emits
`failed` with `code: 'resume_session_mismatch'`.

## Consume Events

Primary stream: async iterator. `onEvent` is only a side channel for logging or
mirroring.

Consume these first:

- `codex_session`: persist `codexSessionId`.
- `text_delta`: append assistant text.
- `exec_started`: show command start.
- `exec_finished`: show command result.
- `completed`: mark success.
- `failed`: mark failure.
- `aborted`: mark timeout or abort.

Other normalized events:

- `agent_message`
- `reasoning`
- `file_change`
- `web_search`
- `todo_list`
- `plan_update`
- `approval_request`
- `tool_call`
- `tool_result`
- `usage`
- `unknown`

## Minimal Handler

```ts
function handleEvent(event: CodexRunnerEvent): void {
  switch (event.kind) {
    case 'codex_session':
      saveSessionId(event.codexSessionId);
      return;
    case 'text_delta':
      appendText(event.text);
      return;
    case 'completed':
      finish({ ok: true, usage: event.usage });
      return;
    case 'failed':
      finish({ ok: false, code: event.code, message: event.message });
      return;
    case 'aborted':
      finish({ ok: false, code: event.reason });
      return;
  }
}
```

## Failure Codes

Handle these as stable control-flow values:

- `spawn_error`
- `stdout_read_error`
- `line_too_large`
- `queue_overflow`
- `codex_exit`
- `resume_session_mismatch`
- `turn_failed`
- `stream_error`
- `callback_error`

Failure events may include `stderr`, `exitCode`, `exitSignal`, `lastEvent`, and
`codexSessionId`.

## Request Fields

Common fields:

- `prompt`
- `cwd`
- `codexHome`
- `model`
- `sandbox`
- `approvalMode`
- `skipGitRepoCheck`
- `timeoutMs`
- `signal`
- `env`
- `extraEnv`

Advanced fields:

- `ephemeral`
- `ignoreUserConfig`
- `ignoreRules`
- `profile`
- `config`
- `images`
- `addDirs`
- `outputLastMessagePath`
- `outputSchemaPath`
- `dangerouslyBypassApprovalsAndSandbox`
- `extraArgs`

Use `extraArgs` only for new Codex CLI flags not yet represented by typed
fields.

## Operational Notes

- Breaking out of the async iterator terminates the Codex child process.
- Timeout emits `aborted` with `reason: 'timeout'`.
- AbortSignal emits `aborted` with `reason: 'signal'`.
- stdout is JSONL with a per-line byte limit.
- stderr is a redacted bounded tail.
- Secret-looking values are redacted before events are emitted.
