import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TelegramTransport } from "./transport.ts";

describe("TelegramTransport", () => {
  it("constructs with defaults", () => {
    const t = new TelegramTransport({ botToken: "1:abc" });
    assert.ok(t);
  });
});
