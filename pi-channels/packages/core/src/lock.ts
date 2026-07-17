/**
 * Cross-process connect lock: one poller per channel profile.
 *
 * File: <agentDir>/tmp/channels/locks/<channel>-<profile>.json
 * Heartbeat keeps the lease alive; dead pid / stale heartbeat can be stolen.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ChannelLockOwner {
  channelId: string;
  profileId: string;
  instanceId: string;
  pid: number;
  /** Optional short session label for humans */
  sessionHint?: string;
  /** Token fingerprint (not the raw token) */
  tokenFp?: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface AcquireLockResult {
  ok: true;
  owner: ChannelLockOwner;
  path: string;
}

export interface AcquireLockDenied {
  ok: false;
  reason: "held";
  path: string;
  holder: ChannelLockOwner;
  holderAlive: boolean;
  holderStale: boolean;
}

export type AcquireChannelLockResult = AcquireLockResult | AcquireLockDenied;

export interface ChannelLockOptions {
  agentDir: string;
  channelId: string;
  profileId: string;
  instanceId: string;
  sessionHint?: string;
  /** Raw bot token — only a short hash is stored */
  botToken?: string;
  /** Steal if heartbeat older than this (ms). Default 45s. */
  staleMs?: number;
  /** Allow steal when force=true even if holder looks alive. */
  force?: boolean;
}

const DEFAULT_STALE_MS = 45_000;

export function channelLockPath(
  agentDir: string,
  channelId: string,
  profileId: string,
): string {
  const safeChannel = sanitize(channelId);
  const safeProfile = sanitize(profileId);
  return join(
    agentDir,
    "tmp",
    "channels",
    "locks",
    `${safeChannel}-${safeProfile}.json`,
  );
}

export function tokenFingerprint(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export async function readChannelLock(
  path: string,
): Promise<ChannelLockOwner | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.channelId !== "string" ||
      typeof o.profileId !== "string" ||
      typeof o.instanceId !== "string" ||
      typeof o.pid !== "number" ||
      typeof o.acquiredAt !== "number" ||
      typeof o.heartbeatAt !== "number"
    ) {
      return undefined;
    }
    return {
      channelId: o.channelId,
      profileId: o.profileId,
      instanceId: o.instanceId,
      pid: o.pid,
      sessionHint:
        typeof o.sessionHint === "string" ? o.sessionHint : undefined,
      tokenFp: typeof o.tokenFp === "string" ? o.tokenFp : undefined,
      acquiredAt: o.acquiredAt,
      heartbeatAt: o.heartbeatAt,
    };
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLockStale(
  owner: ChannelLockOwner,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
): boolean {
  return now - owner.heartbeatAt > staleMs;
}

/**
 * Try to acquire the connect lock for this channel profile.
 * Same instanceId can re-enter (refresh).
 */
export async function acquireChannelLock(
  options: ChannelLockOptions,
): Promise<AcquireChannelLockResult> {
  const path = channelLockPath(
    options.agentDir,
    options.channelId,
    options.profileId,
  );
  await mkdir(dirname(path), { recursive: true });
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = Date.now();
  const desired: ChannelLockOwner = {
    channelId: options.channelId,
    profileId: options.profileId,
    instanceId: options.instanceId,
    pid: process.pid,
    sessionHint: options.sessionHint,
    tokenFp: tokenFingerprint(options.botToken),
    acquiredAt: now,
    heartbeatAt: now,
  };

  const existing = await readChannelLock(path);
  if (existing) {
    const sameInstance = existing.instanceId === options.instanceId;
    const alive = isPidAlive(existing.pid);
    const stale = isLockStale(existing, now, staleMs);

    if (sameInstance) {
      desired.acquiredAt = existing.acquiredAt;
      await writeLockAtomic(path, desired);
      return { ok: true, owner: desired, path };
    }

    const canSteal = options.force === true || !alive || stale;
    if (!canSteal) {
      return {
        ok: false,
        reason: "held",
        path,
        holder: existing,
        holderAlive: alive,
        holderStale: stale,
      };
    }
  }

  // Create/replace via temp + rename for a bit of atomicity
  await writeLockAtomic(path, desired);
  // Re-read to detect lost race (best-effort)
  const verify = await readChannelLock(path);
  if (!verify || verify.instanceId !== options.instanceId) {
    const holder = verify ?? existing;
    if (holder && holder.instanceId !== options.instanceId) {
      return {
        ok: false,
        reason: "held",
        path,
        holder,
        holderAlive: isPidAlive(holder.pid),
        holderStale: isLockStale(holder, Date.now(), staleMs),
      };
    }
  }
  return { ok: true, owner: desired, path };
}

export async function heartbeatChannelLock(
  options: Pick<
    ChannelLockOptions,
    "agentDir" | "channelId" | "profileId" | "instanceId"
  >,
): Promise<boolean> {
  const path = channelLockPath(
    options.agentDir,
    options.channelId,
    options.profileId,
  );
  const existing = await readChannelLock(path);
  if (!existing || existing.instanceId !== options.instanceId) return false;
  const next: ChannelLockOwner = {
    ...existing,
    pid: process.pid,
    heartbeatAt: Date.now(),
  };
  await writeLockAtomic(path, next);
  return true;
}

export async function releaseChannelLock(
  options: Pick<
    ChannelLockOptions,
    "agentDir" | "channelId" | "profileId" | "instanceId"
  >,
): Promise<boolean> {
  const path = channelLockPath(
    options.agentDir,
    options.channelId,
    options.profileId,
  );
  const existing = await readChannelLock(path);
  if (!existing) return true;
  if (existing.instanceId !== options.instanceId) return false;
  try {
    await unlink(path);
  } catch {
    // ignore
  }
  return true;
}

export function formatLockHolder(holder: ChannelLockOwner): string {
  const alive = isPidAlive(holder.pid) ? "alive" : "dead";
  const ageSec = Math.round((Date.now() - holder.heartbeatAt) / 1000);
  const hint = holder.sessionHint ? ` session=${holder.sessionHint}` : "";
  return `instance=${holder.instanceId} pid=${holder.pid} (${alive}, heartbeat ${ageSec}s ago)${hint}`;
}

async function writeLockAtomic(
  path: string,
  owner: ChannelLockOwner,
): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(owner, null, "\t")}\n`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "default";
}

/** Test helper: exclusive create using O_EXCL (stricter, optional). */
export async function tryCreateExclusive(
  path: string,
  owner: ChannelLockOwner,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, "\t")}\n`, "utf8");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}
