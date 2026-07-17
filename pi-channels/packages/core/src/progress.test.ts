import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProgressDraftState,
  formatToolProgressLine,
  pushProgressLine,
  renderProgressDraftText,
  truncateProgressLine,
} from "./progress.ts";
import { DEFAULT_PROGRESS_POLICY } from "./types.ts";

describe("progress draft", () => {
  it("formats tool lines compactly", () => {
    const line = formatToolProgressLine(
      "read",
      { path: "/home/xjc/projects/pi-channels/packages/core/src/runtime.ts" },
      100,
    );
    assert.match(line, /^📖 read:/);
    assert.ok(line.length <= 100);
  });

  it("keeps max lines and renders without dumping secrets", () => {
    let state = createProgressDraftState({
      channelId: "telegram",
      profileId: "default",
      address: { chatId: 1 },
    });
    for (let i = 0; i < 8; i += 1) {
      state = pushProgressLine(
        state,
        formatToolProgressLine("bash", { command: `echo ${i}` }, 80),
        DEFAULT_PROGRESS_POLICY,
      );
    }
    assert.equal(state.lines.length, DEFAULT_PROGRESS_POLICY.maxLines);
    const text = renderProgressDraftText(state);
    assert.doesNotMatch(text, /password|token/i);
    assert.ok(text.includes("🛠️"));
  });

  it("truncates long lines with middle ellipsis", () => {
    const long = "a".repeat(200);
    const out = truncateProgressLine(long, 40);
    assert.equal(out.length, 40);
    assert.ok(out.includes("…"));
  });
});
