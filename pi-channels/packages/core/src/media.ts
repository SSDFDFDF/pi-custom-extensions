/**
 * Media classification for channel attachments.
 */

import type { ChannelAttachment } from "./types.ts";

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

/** True when this attachment should enter the model as a multimodal image. */
export function isMultimodalImageAttachment(
  file: Pick<ChannelAttachment, "kind" | "path" | "fileName" | "mimeType">,
): boolean {
  if (file.kind === "image") return true;
  const mime = file.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return true;
  const name = (file.fileName ?? file.path ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && IMAGE_EXT.has(name.slice(dot))) return true;
  return false;
}

export function guessMimeFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) {
    return "text/plain";
  }
  return undefined;
}
