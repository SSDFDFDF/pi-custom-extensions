import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChannelRuntime } from "./runtime.ts";
import type { OutboundIntent } from "./types.ts";

describe("channel_attach queue + document image multimodal", () => {
  it("queues attach files and sends after final on settled", async () => {
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
      eventId: "1",
      target: {
        channelId: "telegram",
        profileId: "default",
        address: { chatId: 1 },
      },
      sender: { id: "1" },
      createdAt: Date.now(),
      text: "send me a file",
      rawRef: { messageId: 9 },
    });
    rt.onAgentStart();
    const dir = join(tmpdir(), "pi-channels-attach-test");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "out.txt");
    await writeFile(path, "hello");
    const queued = await rt.attachFiles([{ path, fileName: "out.txt" }]);
    assert.equal(queued.mode, "queued");
    await rt.onAgentEnd("here is the file");
    assert.equal(delivered.filter((d) => d.kind === "attach").length, 0);
    await rt.onAgentSettled();
    const kinds = delivered.map((d) => d.kind);
    assert.ok(kinds.includes("final"));
    assert.ok(kinds.includes("attach"));
    const attach = delivered.find((d) => d.kind === "attach");
    assert.ok(attach && attach.kind === "attach");
    assert.equal(attach.files[0]?.path, path);
  });

  it("maps image document attachments to image content blocks", async () => {
    const sent: unknown[] = [];
    const rt = new ChannelRuntime({
      instanceId: "t2",
      progress: { mode: "off" },
      ports: {
        isIdle: () => true,
        sendUserMessage: async (content) => {
          sent.push(content);
        },
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
      deliver: async () => ({ ok: true }),
    });

    await rt.handleEvent({
      type: "message",
      eventId: "2",
      target: {
        channelId: "telegram",
        profileId: "default",
        address: { chatId: 1 },
      },
      sender: { id: "1" },
      createdAt: Date.now(),
      text: "see file",
      attachments: [
        {
          kind: "document",
          path: "/tmp/screenshot.png",
          fileName: "screenshot.png",
          mimeType: "image/png",
        },
      ],
    });

    const content = sent[0] as Array<{ type: string; path?: string }>;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((block) => block.type === "image"));
    assert.ok(
      content.some(
        (block) =>
          block.type === "image" && block.path === "/tmp/screenshot.png",
      ),
    );
  });
});
