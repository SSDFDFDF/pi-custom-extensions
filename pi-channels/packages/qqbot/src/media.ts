/**
 * QQ Bot media helpers: file_type mapping, inbound download, outbound upload.
 *
 * Upload: POST /v2/users/{openid}/files  or  /v2/groups/{group_openid}/files
 * Send:   msg_type=7 + media.file_info
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AttachmentKind, ChannelAttachment } from "../../core/src/index.ts";
import { guessMimeFromName } from "../../core/src/index.ts";

/** Official file_type: 1 image, 2 video, 3 voice, 4 file */
export type QqbotFileType = 1 | 2 | 3 | 4;

export const FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface InboundAttachmentRaw {
  url?: string;
  content_type?: string;
  contentType?: string;
  filename?: string;
  file_name?: string;
  size?: number;
  /** some payloads use different shapes */
  content?: string;
}

export function classifyFileType(
  fileName?: string,
  mimeType?: string,
): QqbotFileType {
  const mime = (mimeType ?? "").toLowerCase();
  const name = (fileName ?? "").toLowerCase();
  const ext = extname(name);

  if (
    mime.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)
  ) {
    return 1;
  }
  if (mime.startsWith("video/") || [".mp4", ".mov", ".m4v"].includes(ext)) {
    return 2;
  }
  if (
    mime.startsWith("audio/") ||
    [".silk", ".wav", ".mp3", ".flac", ".ogg", ".opus", ".amr"].includes(ext)
  ) {
    return 3;
  }
  return 4;
}

export function fileTypeToKind(fileType: QqbotFileType): AttachmentKind {
  if (fileType === 1) return "image";
  if (fileType === 2) return "video";
  if (fileType === 3) return "voice";
  return "document";
}

export function kindFromMimeOrName(
  mimeType?: string,
  fileName?: string,
): AttachmentKind {
  return fileTypeToKind(classifyFileType(fileName, mimeType));
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-()+@]+/g, "_").slice(0, 120) || "file.bin";
}

export async function downloadUrlToTemp(
  url: string,
  tempDir: string,
  options?: {
    fileName?: string;
    mimeType?: string;
    maxBytes?: number;
  },
): Promise<ChannelAttachment> {
  const maxBytes = options?.maxBytes ?? FILE_MAX_BYTES;
  await mkdir(tempDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  const contentType =
    options?.mimeType ??
    response.headers.get("content-type")?.split(";")[0]?.trim() ??
    undefined;

  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`file too large (>${maxBytes}): ${buf.byteLength}`);
  }

  const fromUrl = (() => {
    try {
      const u = new URL(url);
      const base = basename(u.pathname);
      return base && base !== "/" ? base : undefined;
    } catch {
      return undefined;
    }
  })();

  const rawName =
    options?.fileName ||
    fromUrl ||
    `download-${randomUUID().slice(0, 8)}${extFromMime(contentType)}`;
  const safeName = sanitizeFileName(rawName);
  const path = join(tempDir, `${Date.now()}-${safeName}`);
  await writeFile(path, buf);

  const kind = kindFromMimeOrName(contentType, safeName);
  return {
    kind,
    path,
    fileName: safeName,
    mimeType: contentType ?? guessMimeFromName(safeName),
    byteSize: buf.byteLength,
    remoteId: url.slice(0, 200),
  };
}

export async function collectInboundAttachments(
  rawList: InboundAttachmentRaw[] | undefined,
  tempDir: string,
  log?: (message: string) => void,
): Promise<ChannelAttachment[]> {
  if (!rawList?.length) return [];
  const out: ChannelAttachment[] = [];

  for (const [index, raw] of rawList.entries()) {
    const url = raw.url?.trim();
    const mimeType = raw.content_type ?? raw.contentType;
    const fileName =
      raw.filename ??
      raw.file_name ??
      (url ? safeUrlBaseName(url) : undefined);
    const size = raw.size;

    if (!url) {
      out.push({
        kind: kindFromMimeOrName(mimeType, fileName),
        fileName,
        mimeType,
        byteSize: size,
      });
      continue;
    }

    if (size && size > FILE_MAX_BYTES) {
      out.push({
        kind: kindFromMimeOrName(mimeType, fileName),
        remoteId: url.slice(0, 200),
        fileName,
        mimeType,
        byteSize: size,
      });
      continue;
    }

    try {
      const downloaded = await downloadUrlToTemp(url, tempDir, {
        fileName: fileName || `attach-${index}`,
        mimeType,
      });
      out.push(downloaded);
    } catch (error) {
      log?.(
        `inbound attach download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      out.push({
        kind: kindFromMimeOrName(mimeType, fileName),
        remoteId: url.slice(0, 200),
        fileName,
        mimeType,
        byteSize: size,
      });
    }
  }

  return out;
}

export interface UploadMediaResult {
  file_uuid?: string;
  file_info?: string;
  ttl?: number;
}

export async function readLocalFileBase64(
  filePath: string,
  maxBytes = FILE_MAX_BYTES,
): Promise<{ base64: string; byteSize: number; fileName: string }> {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`file too large (>${maxBytes}): ${filePath}`);
  }
  return {
    base64: bytes.toString("base64"),
    byteSize: bytes.byteLength,
    fileName: basename(filePath),
  };
}

function extFromMime(mime?: string): string {
  if (!mime) return ".bin";
  const m = mime.toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("gif")) return ".gif";
  if (m.includes("webp")) return ".webp";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("pdf")) return ".pdf";
  return ".bin";
}

function safeUrlBaseName(url: string): string | undefined {
  try {
    const base = basename(new URL(url).pathname);
    return base && base !== "/" ? base : undefined;
  } catch {
    return undefined;
  }
}
