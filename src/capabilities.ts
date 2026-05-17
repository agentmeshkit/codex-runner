import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';

const DEFAULT_CODEX_BIN = 'codex';
const DEFAULT_TIMEOUT_MS = 5000;

export type CodexCapabilitySpawnInvocation = {
  bin: string;
  args: string[];
};

export type CodexCapabilityChildProcess = {
  stdout?: Readable | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
};

export type CodexCapabilitySpawnFunction = (
  invocation: CodexCapabilitySpawnInvocation,
) => CodexCapabilityChildProcess;

export type DetectCodexCliCapabilitiesOptions = {
  codexBin?: string;
  spawn?: CodexCapabilitySpawnFunction;
  timeoutMs?: number;
};

export type CodexCliCapabilities = {
  bin: string;
  version?: string;
  supportsJson: boolean;
  supportsResume: boolean;
  supportsSandbox: boolean;
  supportsSkipGitRepoCheck: boolean;
  rawVersionOutput?: string;
  rawExecHelpOutput?: string;
  warnings: string[];
};

type CommandResult = {
  ok: boolean;
  output: string;
  warning?: string;
};

export async function detectCodexCliCapabilities(
  options: DetectCodexCliCapabilitiesOptions = {},
): Promise<CodexCliCapabilities> {
  const codexBin = options.codexBin ?? DEFAULT_CODEX_BIN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!codexBin) throw new Error('codexBin must be a non-empty string');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }

  const spawnFn = options.spawn ?? defaultSpawn;
  const warnings: string[] = [];
  const base = (): CodexCliCapabilities => ({
    bin: codexBin,
    supportsJson: false,
    supportsResume: false,
    supportsSandbox: false,
    supportsSkipGitRepoCheck: false,
    warnings,
  });

  const versionResult = await runCodexCommand(
    { bin: codexBin, args: ['--version'] },
    spawnFn,
    timeoutMs,
  );
  if (versionResult.warning) warnings.push(versionResult.warning);

  const helpResult = await runCodexCommand(
    { bin: codexBin, args: ['exec', '--help'] },
    spawnFn,
    timeoutMs,
  );
  if (helpResult.warning) warnings.push(helpResult.warning);

  const capabilities = base();
  if (versionResult.output) {
    capabilities.rawVersionOutput = versionResult.output;
    capabilities.version = parseVersion(versionResult.output);
  }
  if (helpResult.output) capabilities.rawExecHelpOutput = helpResult.output;

  if (!versionResult.ok || !helpResult.ok) return capabilities;

  capabilities.supportsJson = hasFlag(helpResult.output, '--json');
  capabilities.supportsResume = hasWord(helpResult.output, 'resume');
  capabilities.supportsSandbox = hasFlag(helpResult.output, '--sandbox');
  capabilities.supportsSkipGitRepoCheck = hasFlag(
    helpResult.output,
    '--skip-git-repo-check',
  );

  return capabilities;
}

function defaultSpawn(
  invocation: CodexCapabilitySpawnInvocation,
): CodexCapabilityChildProcess {
  return nodeSpawn(invocation.bin, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runCodexCommand(
  invocation: CodexCapabilitySpawnInvocation,
  spawnFn: CodexCapabilitySpawnFunction,
  timeoutMs: number,
): Promise<CommandResult> {
  let child: CodexCapabilityChildProcess;
  try {
    child = spawnFn(invocation);
  } catch (error) {
    return {
      ok: false,
      output: '',
      warning: `${formatCommand(invocation)} spawn failed: ${formatError(error)}`,
    };
  }

  let output = '';
  const append = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The command result below is enough for capability detection.
      }
      finish({
        ok: false,
        output,
        warning: `${formatCommand(invocation)} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timeout.unref?.();

    child.once('error', (error) => {
      finish({
        ok: false,
        output,
        warning: `${formatCommand(invocation)} failed: ${formatError(error)}`,
      });
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish({ ok: true, output });
        return;
      }

      const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
      finish({
        ok: false,
        output,
        warning: `${formatCommand(invocation)} failed with ${status}`,
      });
    });
  });
}

function parseVersion(output: string): string | undefined {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

function hasFlag(output: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(flag)}([\\s,]|$)`).test(output);
}

function hasWord(output: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(output);
}

function formatCommand(invocation: CodexCapabilitySpawnInvocation): string {
  return [invocation.bin, ...invocation.args].join(' ');
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
