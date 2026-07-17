/**
 * Extract assistant-visible text from Pi agent messages (agent_end payload).
 */

export function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = Reflect.get(message, "role");
    if (role !== "assistant") continue;
    const content = Reflect.get(message, "content");
    const text = extractTextContent(content);
    if (text.trim()) return text;
  }
  return "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}
