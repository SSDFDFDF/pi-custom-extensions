import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireChannelLock,
  formatLockHolder,
  heartbeatChannelLock,
  readChannelLock,
  releaseChannelLock,
} from "./lock.ts";

describe("channel connect lock", () => {
  it("allows one owner and blocks another instance", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ch-lock-"));
    try {
      const a = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "inst-a",
        sessionHint: "session-a",
        botToken: "1:token",
      });
      assert.equal(a.ok, true);

      const b = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "inst-b",
        sessionHint: "session-b",
        botToken: "1:token",
      });
      assert.equal(b.ok, false);
      if (!b.ok) {
        assert.equal(b.holder.instanceId, "inst-a");
        assert.match(formatLockHolder(b.holder), /inst-a/);
      }

      const released = await releaseChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "inst-a",
      });
      assert.equal(released, true);

      const c = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "inst-b",
      });
      assert.equal(c.ok, true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("same instance can re-acquire and heartbeat", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ch-lock2-"));
    try {
      const a = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "same",
      });
      assert.equal(a.ok, true);
      const again = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "same",
      });
      assert.equal(again.ok, true);
      const beat = await heartbeatChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "same",
      });
      assert.equal(beat, true);
      const path = again.ok ? again.path : "";
      const owner = await readChannelLock(path);
      assert.equal(owner?.instanceId, "same");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("force steals a live lock", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ch-lock3-"));
    try {
      await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "old",
      });
      const forced = await acquireChannelLock({
        agentDir,
        channelId: "telegram",
        profileId: "default",
        instanceId: "new",
        force: true,
      });
      assert.equal(forced.ok, true);
      if (forced.ok) assert.equal(forced.owner.instanceId, "new");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
