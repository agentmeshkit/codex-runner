export interface CodexRunnerOptions {
  codexBin?: string;
}

export interface CodexTurnRequest {
  prompt: string;
  cwd: string;
  codexHome?: string;
  model?: string;
  sandbox?: string;
}

export function createCodexRunner(options: CodexRunnerOptions = {}) {
  return {
    codexBin: options.codexBin ?? 'codex',
  };
}

