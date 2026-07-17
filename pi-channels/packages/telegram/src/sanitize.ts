/**
 * Web-oriented Markdown sanitizer for Telegram compat rendering.
 */

export interface SanitizeOptions {
  neutralizeMath?: boolean;
}

const TELEGRAM_MARKUP_COMMENT = /^<!--\s*telegram_(?:button|voice)\b/i;

function stashProtectedRegions(text: string): {
  text: string;
  restore: (value: string) => string;
} {
  const tokens: string[] = [];
  const stash = (chunk: string): string => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(chunk);
    return token;
  };

  let result = text.replace(
    /(^|\n)( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(\n\2\3[^\n]*|$)/g,
    (full) => stash(full.startsWith("\n") ? full.slice(1) : full),
  );
  result = result.replace(/`+[^`\n]*`+/g, (code) => stash(code));
  result = result
    .split("\n")
    .map((line) => (TELEGRAM_MARKUP_COMMENT.test(line) ? stash(line) : line))
    .join("\n");

  return {
    text: result,
    restore: (value: string) =>
      value.replace(
        /\uE000(\d+)\uE001/g,
        (_m, index) => tokens[Number(index)] ?? "",
      ),
  };
}

export function sanitizeTelegramWebMarkdown(
  markdown: string,
  options: SanitizeOptions = {},
): string {
  if (!markdown) return markdown;
  const neutralizeMath = options.neutralizeMath !== false;
  const { text, restore } = stashProtectedRegions(markdown.replace(/\r\n/g, "\n"));
  let next = text;
  if (neutralizeMath) {
    next = next.replace(
      /(^|\n)\$\$\s*\n([\s\S]*?)\n\$\$\s*(?=\n|$)/g,
      (_m, lead: string, body: string) =>
        `${lead}\`\`\`math\n${body.trimEnd()}\n\`\`\``,
    );
    next = next.replace(
      /(^|[^\\$])\$([^$\n]{1,120})\$/g,
      (full, prefix: string, body: string) => {
        const looksLikeMath =
          /[=^_\\{}]|\\[a-zA-Z]+|\d/.test(body) && !/https?:\/\//.test(body);
        if (!looksLikeMath) return full;
        return `${prefix}\`${body}\``;
      },
    );
  }
  next = next.replace(
    /(^|[^\\$])\$([A-Z][A-Z0-9]{1,})(?!\$)(?=\b|[.,;:)/-])/g,
    (_m, prefix: string, ticker: string) => `${prefix}\\$${ticker}`,
  );
  next = next
    .split("\n")
    .map((line) => {
      const match = line.match(/^( {0,3})(>+)(.*)$/);
      if (!match) return line;
      const indent = match[1] ?? "";
      const body = match[3] ?? "";
      return `${indent}>${body.startsWith(" ") || body === "" ? body : ` ${body}`}`;
    })
    .join("\n");
  next = next.replace(
    /<\/?(?:div|span|p|section|article|header|footer|nav|table|thead|tbody|tr|td|th|img|script|style|iframe|object|embed|form|input|button|svg|math)(?:\s[^>]*)?>/gi,
    "",
  );
  next = next.replace(/\n{4,}/g, "\n\n\n");
  const restored = restore(next);
  return restored === markdown ? markdown : restored;
}
