/**
 * Outbound text shaping for QQ Bot.
 *
 * - plain:  msg_type 0, strip markdown noise
 * - native / compat: msg_type 2, markdown.content (custom MD, no template)
 *
 * Official custom markdown (C2C/group): titles, bold/italic/strike, links,
 * lists, blockquote, hr. Images in MD need public URLs.
 */

import type { RenderPolicy } from "../../core/src/index.ts";

export function usesQqbotMarkdown(render: RenderPolicy): boolean {
  return render.finalFormat === "native" || render.finalFormat === "compat";
}

/** Shape text for plain msg_type=0. */
export function toQqbotPlainText(
  text: string,
  render: Pick<RenderPolicy, "sanitizeMarkdown" | "neutralizeMath">,
): string {
  let out = text ?? "";
  if (render.sanitizeMarkdown) {
    out = stripMarkdownNoise(out);
  }
  if (render.neutralizeMath) {
    out = neutralizeMath(out);
  }
  return out.trim();
}

/**
 * Shape text for markdown.content (msg_type=2).
 * Keeps structure; lightly normalizes so QQ parser is happier.
 */
export function toQqbotMarkdownContent(
  text: string,
  render: Pick<RenderPolicy, "neutralizeMath">,
): string {
  let out = text ?? "";
  if (render.neutralizeMath) {
    out = neutralizeMath(out);
  }
  // Normalize CRLF; trim trailing spaces that break list parsing
  out = out.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  // Ensure fenced code stays readable (QQ may not style fences; keep as-is)
  return out.trim();
}

/** @deprecated use toQqbotPlainText / toQqbotMarkdownContent */
export function toQqbotOutboundText(
  text: string,
  render: RenderPolicy,
): string {
  if (usesQqbotMarkdown(render)) {
    return toQqbotMarkdownContent(text, render);
  }
  return toQqbotPlainText(text, render);
}

function neutralizeMath(out: string): string {
  return out
    .replace(/\$\$[\s\S]+?\$\$/g, "[math]")
    .replace(/\$[^$\n]+\$/g, "[math]");
}

function stripMarkdownNoise(out: string): string {
  return out
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, (block) => {
      const inner = block.replace(/^`{3}\w*\n?/, "").replace(/`{3}$/, "");
      return inner.trim();
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}
