import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelRuntime } from "./runtime.ts";
import type { OutboundIntent } from "./types.ts";

describe("reply anchor on final", () => {
  it("passes inbound rawRef as replyTo on final deliver", async () => {
    const delivered: OutboundIntent[] = [];
    const rt = new ChannelRuntime({
      instanceId: "t",
      progress: { mode: "off" },
      ports: {
        isIdle: () => true,
        sendUserMessage: async () => {},
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
        return { ok: true };
      },
    });

    await rt.handleEvent({
      type: "message",
      eventId: "9",
      target: {
        channelId: "telegram",
        profileId: "default",
        address: { chatId: 7 },
      },
      sender: { id: "1" },
      createdAt: Date.now(),
      text: "hi",
      rawRef: { messageId: 12345 },
    });
    rt.onAgentStart();
    await rt.onAgentEnd("answer");
    await rt.onAgentSettled();

    const final = delivered.find((d) => d.kind === "final");
    assert.ok(final && final.kind === "final");
    assert.deepEqual(final.replyTo?.raw, { messageId: 12345 });
  });
});
