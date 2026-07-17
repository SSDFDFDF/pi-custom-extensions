/**
 * Minimal Markdown → Telegram HTML for compat/web path.
 * Not a full CommonMark parser — good enough for assistant answers:
 * headings, bold/italic, strike, inline code, fences, links, quotes, lists.
 */

import { sanitizeTelegramWebMarkdown } from "./sanitize.ts";

const MAX = 4096;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(text: string): string {
  let result = text;
  // links [label](url)
  result = result.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
  );
  // inline code
  result = result.replace(
    /`([^`]+)`/g,
    (_m, code: string) => `<code>${escapeHtml(code)}</code>`,
  );
  // bold/italic/strike on remaining text segments is naive; escape first then apply
  // Split by existing tags
  const parts = result.split(/(<[^>]+>)/g);
  return parts
    .map((part) => {
      if (part.startsWith("<")) return part;
      let s = escapeHtml(part);
      s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><i>$1</i></b>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/\*([^*]+)\*/g, "<i>$1</i>");
      s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
      return s;
    })
    .join("");
}

export function markdownToTelegramHtml(
  markdown: string,
  options?: { sanitize?: boolean; neutralizeMath?: boolean },
): string[] {
  const source =
    options?.sanitize === false
      ? markdown
      : sanitizeTelegramWebMarkdown(markdown, {
          neutralizeMath: options?.neutralizeMath,
        });

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let fence: string | undefined;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceOpen = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && fenceOpen) {
      fence = fenceOpen[1]?.[0];
      const lang = (fenceOpen[2] ?? "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (new RegExp(`^ {0,3}${fenceOpen[1]}\\s*$`).test(l)) break;
        body.push(l);
        i += 1;
      }
      const open =
        lang.length > 0
          ? `<pre><code class="language-${escapeHtml(lang)}">`
          : "<pre><code>";
      out.push(`${open}${escapeHtml(body.join("\n"))}</code></pre>`);
      fence = undefined;
      i += 1;
      continue;
    }

    if (/^ {0,3}#{1,6}\s+/.test(line)) {
      out.push(`<b>${renderInline(line.replace(/^ {0,3}#{1,6}\s+/, ""))}</b>`);
      i += 1;
      continue;
    }
    if (/^ {0,3}>\s?/.test(line)) {
      out.push(
        `<blockquote>${renderInline(line.replace(/^ {0,3}>\s?/, ""))}</blockquote>`,
      );
      i += 1;
      continue;
    }
    if (/^ {0,3}[-*+]\s+/.test(line)) {
      out.push(`• ${renderInline(line.replace(/^ {0,3}[-*+]\s+/, ""))}`);
      i += 1;
      continue;
    }
    if (/^ {0,3}\d+\.\s+/.test(line)) {
      const m = line.match(/^ {0,3}(\d+)\.\s+(.*)$/);
      out.push(
        `${m?.[1] ?? "1"}. ${renderInline(m?.[2] ?? "")}`,
      );
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      i += 1;
      continue;
    }
    out.push(renderInline(line));
    i += 1;
  }

  const joined = out.join("\n").trim();
  if (!joined) return [];
  if (joined.length <= MAX) return [joined];

  // crude chunk on paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  for (const para of joined.split(/\n\n+/)) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= MAX) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (para.length <= MAX) current = para;
      else {
        for (let off = 0; off < para.length; off += MAX) {
          chunks.push(para.slice(off, off + MAX));
        }
        current = "";
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
