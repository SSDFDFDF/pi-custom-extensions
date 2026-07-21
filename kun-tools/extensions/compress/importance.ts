/** Lines matching these patterns are never dropped by drop-capable stages. */
const IMPORTANT_PATTERNS: RegExp[] = [
  /\b(error|err!|fatal|panic|exception|traceback|stacktrace)\b/i,
  /\b(warn|warning|deprecat)/i,
  /\b(fail|failed|failure)\b/i,
  /\b(pass(?:ed|ing)?|ok)\b.*\b\d+\b/i,
  /\b\d+\s+(passing|failing|failed|passed|errors?|warnings?)\b/i,
  /[✓✔✗✘×]/,
  /\bE\d{2,}\b/,
  /\bERR_[A-Z0-9_]+/,
  /\bexit(?:ed)?\b.*\bcode\b/i,
  /\b[\w./-]+\.[a-z]{1,5}:\d+(?::\d+)?/i,
  /\bat\s+.+\([^)]+:\d+(?::\d+)?\)/,
  /错误|失败|异常|警告|退出码/,
];

export function isImportant(line: string): boolean {
  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(line));
}
