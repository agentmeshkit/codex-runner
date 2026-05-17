import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  detectCodexCliCapabilities,
  type CodexCapabilityChildProcess,
  type CodexCapabilitySpawnFunction,
  type CodexCapabilitySpawnInvocation,
} from '../src/index.js';

class FakeCapabilityChild extends EventEmitter implements CodexCapabilityChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function createSpawn(
  handler: (invocation: CodexCapabilitySpawnInvocation) => FakeCapabilityChild,
): CodexCapabilitySpawnFunction {
  return handler;
}

describe('detectCodexCliCapabilities', () => {
  it('detects version and supported exec flags', async () => {
    const invocations: CodexCapabilitySpawnInvocation[] = [];
    const spawn = createSpawn((invocation) => {
      invocations.push(invocation);
      const child = new FakeCapabilityChild();
      setImmediate(() => {
        if (invocation.args[0] === '--version') {
          child.stdout.write('codex-cli 0.130.0\n');
        } else {
          child.stdout.write(`
Usage: codex exec [OPTIONS] [PROMPT]
Commands:
  resume <SESSION_ID>
Options:
  --json
  --sandbox <MODE>
  --skip-git-repo-check
`);
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
      });
      return child;
    });

    const capabilities = await detectCodexCliCapabilities({
      codexBin: '/bin/codex',
      spawn,
    });

    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['--version'],
      ['exec', '--help'],
    ]);
    expect(capabilities).toMatchObject({
      bin: '/bin/codex',
      version: '0.130.0',
      supportsJson: true,
      supportsResume: true,
      supportsSandbox: true,
      supportsSkipGitRepoCheck: true,
      warnings: [],
    });
    expect(capabilities.rawVersionOutput).toContain('0.130.0');
    expect(capabilities.rawExecHelpOutput).toContain('--json');
  });

  it('returns false capabilities and warnings when the CLI is missing', async () => {
    const spawn = createSpawn(() => {
      const error = new Error('spawn codex ENOENT');
      Object.assign(error, { code: 'ENOENT' });
      throw error;
    });

    const capabilities = await detectCodexCliCapabilities({ spawn });

    expect(capabilities).toMatchObject({
      bin: 'codex',
      supportsJson: false,
      supportsResume: false,
      supportsSandbox: false,
      supportsSkipGitRepoCheck: false,
    });
    expect(capabilities.warnings).toHaveLength(2);
    expect(capabilities.warnings.join('\n')).toContain('ENOENT');
  });

  it('times out commands and reports conservative capabilities', async () => {
    const children: FakeCapabilityChild[] = [];
    const spawn = createSpawn(() => {
      const child = new FakeCapabilityChild();
      children.push(child);
      return child;
    });

    const capabilities = await detectCodexCliCapabilities({
      spawn,
      timeoutMs: 1,
    });

    expect(children).toHaveLength(2);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(capabilities).toMatchObject({
      supportsJson: false,
      supportsResume: false,
      supportsSandbox: false,
      supportsSkipGitRepoCheck: false,
    });
    expect(capabilities.warnings.join('\n')).toContain('timed out');
  });

  it('marks missing help flags as unsupported', async () => {
    const spawn = createSpawn((invocation) => {
      const child = new FakeCapabilityChild();
      setImmediate(() => {
        if (invocation.args[0] === '--version') {
          child.stdout.write('codex 0.131.1\n');
        } else {
          child.stdout.write(`
Usage: codex exec [OPTIONS] [PROMPT]
Options:
  --json
  --sandbox <MODE>
`);
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
      });
      return child;
    });

    const capabilities = await detectCodexCliCapabilities({ spawn });

    expect(capabilities).toMatchObject({
      version: '0.131.1',
      supportsJson: true,
      supportsResume: false,
      supportsSandbox: true,
      supportsSkipGitRepoCheck: false,
      warnings: [],
    });
  });
});
