import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelRuntime } from "./runtime.ts";
import type { OutboundIntent } from "./types.ts";

function createRuntime(options?: {
  idle?: () => boolean;
  progress?: { startDelayMs?: number; minEditIntervalMs?: number };
}) {
  const delivered: OutboundIntent[] = [];
  let idle = true;
  const rt = new ChannelRuntime({
    instanceId: "test",
    progress: {
      mode: "progress",
      startDelayMs: options?.progress?.startDelayMs ?? 10,
      minEditIntervalMs: options?.progress?.minEditIntervalMs ?? 50,
      maxLines: 5,
      maxLineChars: 100,
    },
    ports: {
      isIdle: () => options?.idle?.() ?? idle,
      hasPendingMessages: () => false,
      sendUserMessage: async () => {
        // agent_start is simulated by the test
      },
      abortActive: () => {},
    },
  });
  rt.registerAdapter({
    channelId: "telegram",
    connect: async () => {},
    disconnect: async () => {},
    status: () => ({
      channelId: "telegram",
      profileId: "default",
      state: "connected",
    }),
    deliver: async (intent) => {
      delivered.push(intent);
      return { ok: true, nativeMessageIds: ["1"] };
    },
  });
  return {
    rt,
    delivered,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

const tgEvent = {
  type: "message" as const,
  eventId: "1",
  target: {
    channelId: "telegram",
    profileId: "default",
    address: { chatId: 1 },
  },
  sender: { id: "u1" },
  createdAt: Date.now(),
  text: "hello",
};

describe("channel run ownership", () => {
  it("does not push progress/final for local-only agent runs", async () => {
    const { rt, delivered } = createRuntime();
    // Local agent work: no prior channel dispatch
    rt.onAgentStart();
    await rt.onToolStart("bash", { command: "echo hi" });
    await rt.onAgentEnd("local answer");
    await rt.onAgentSettled();
    assert.equal(
      delivered.filter((d) => d.kind === "progress" || d.kind === "final")
        .length,
      0,
    );
  });

  it("binds TG turn and delivers final only on settled", async () => {
    const { rt, delivered } = createRuntime({
      progress: { startDelayMs: 0, minEditIntervalMs: 0 },
    });
    await rt.handleEvent(tgEvent);
    // dispatch already called sendUserMessage; claim agent
    rt.onAgentStart();
    await rt.onToolStart("read", { path: "/tmp/x" });
    await rt.onAgentEnd("**final from tg**");
    // not yet final
    assert.equal(delivered.filter((d) => d.kind === "final").length, 0);
    await rt.onAgentSettled();
    const kinds = delivered.map((d) => d.kind);
    assert.ok(kinds.includes("progress") || kinds.includes("typing"));
    assert.ok(kinds.includes("progress_clear"));
    assert.ok(kinds.includes("final"));
    const final = delivered.find((d) => d.kind === "final");
    assert.equal(final && "text" in final ? final.text : "", "**final from tg**");
  });

  it("throttles subsequent progress edits", async () => {
    const { rt, delivered } = createRuntime({
      progress: { startDelayMs: 0, minEditIntervalMs: 500 },
    });
    await rt.handleEvent(tgEvent);
    rt.onAgentStart();
    await rt.onToolStart("read", { path: "/a" });
    const progressAfterFirst = delivered.filter((d) => d.kind === "progress")
      .length;
    assert.ok(progressAfterFirst >= 1);
    await rt.onToolStart("bash", { command: "ls" });
    const progressAfterSecond = delivered.filter((d) => d.kind === "progress")
      .length;
    // second edit should be coalesced (not immediate) due to throttle
    assert.equal(progressAfterSecond, progressAfterFirst);
    await new Promise((r) => setTimeout(r, 560));
    const progressAfterWait = delivered.filter((d) => d.kind === "progress")
      .length;
    assert.ok(progressAfterWait > progressAfterFirst);
    await rt.onAgentEnd("done");
    await rt.onAgentSettled();
  });

  it("shutdown clears progress without final", async () => {
    const { rt, delivered } = createRuntime({
      progress: { startDelayMs: 0, minEditIntervalMs: 0 },
    });
    await rt.handleEvent(tgEvent);
    rt.onAgentStart();
    await rt.onToolStart("read", { path: "/a" });
    await rt.shutdown();
    assert.ok(delivered.some((d) => d.kind === "progress_clear"));
    assert.equal(delivered.filter((d) => d.kind === "final").length, 0);
  });
});
