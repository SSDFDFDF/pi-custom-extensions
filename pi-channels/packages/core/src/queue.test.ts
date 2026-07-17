import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginDispatch,
  createChannelQueueState,
  enqueueTurn,
  stopClearQueue,
} from "./queue.ts";
import type { ChannelTurn } from "./types.ts";

function turn(
  partial: Partial<ChannelTurn> & Pick<ChannelTurn, "turnId" | "lane">,
): ChannelTurn {
  return {
    target: {
      channelId: "telegram",
      profileId: "default",
      address: { chatId: 1 },
    },
    sourceEventIds: [],
    content: [{ type: "text", text: "hi" }],
    createdAt: partial.createdAt ?? Date.now(),
    transportStamp: "t",
    sessionGen: 0,
    ...partial,
  };
}

describe("channel queue", () => {
  it("orders control before priority before default", () => {
    let state = createChannelQueueState();
    state = enqueueTurn(
      state,
      turn({ turnId: "d", lane: "default", createdAt: 1 }),
    );
    state = enqueueTurn(
      state,
      turn({ turnId: "c", lane: "control", createdAt: 3 }),
    );
    state = enqueueTurn(
      state,
      turn({ turnId: "p", lane: "priority", createdAt: 2 }),
    );
    const first = beginDispatch(state);
    assert.equal(first.turn?.turnId, "c");
  });

  it("stop clears active and queued", () => {
    let state = createChannelQueueState();
    state = enqueueTurn(state, turn({ turnId: "a", lane: "default" }));
    state = beginDispatch(state).state;
    state = stopClearQueue(state);
    assert.equal(state.items.length, 0);
    assert.equal(state.active, undefined);
  });
});
