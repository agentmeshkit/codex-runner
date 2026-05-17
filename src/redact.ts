const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|refresh[_-]?token|authorization|cookie|session)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(sk-proj-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  /\b([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s"']+/gi,
  /\b([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s"']+/gi,
  /\b([A-Za-z0-9_]*PASSWORD[A-Za-z0-9_]*=)[^\s"']+/gi,
  /\b([A-Za-z0-9_]*API_KEY[A-Za-z0-9_]*=)[^\s"']+/gi,
];

export function redactString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix?: string) =>
      prefix && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  return redacted;
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(nested, seen);
  }
  return output;
}

export function redactEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : value === undefined
        ? undefined
        : redactString(value);
  }
  return output;
}
