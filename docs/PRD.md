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
- Normalize Codex JSONL into `@agentmeshkit/protocol` events.
- Support first turn, resumed turns, cancellation, timeout, and process exit
  diagnostics.
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

## Acceptance Criteria

- Unit tests cover first turn, resume, command execution, text deltas, failed
  turns, and process errors.
- Fixture tests replay real Codex JSONL without spawning Codex.
- No secrets are logged.
- The package can be used without AgentWeb.

## Milestones

1. Extract event parser fixtures from AgentWeb.
2. Implement runner API around child process.
3. Add cancellation and timeout tests.
4. Publish `0.1.0`.

