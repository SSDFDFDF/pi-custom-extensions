import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toQqbotMarkdownContent,
  toQqbotOutboundText,
  toQqbotPlainText,
  usesQqbotMarkdown,
} from "./render.ts";
import type { RenderPolicy } from "../../core/src/index.ts";

const plain: RenderPolicy = {
  finalFormat: "plain",
  sanitizeMarkdown: true,
  neutralizeMath: true,
  draftPreviews: false,
};

const md: RenderPolicy = {
  finalFormat: "compat",
  sanitizeMarkdown: false,
  neutralizeMath: true,
  draftPreviews: false,
};

describe("toQqbotOutboundText", () => {
  it("strips simple markdown when plain+sanitize", () => {
    const out = toQqbotOutboundText("**hello** `code`", plain);
    assert.equal(out, "hello code");
  });

  it("neutralizes math", () => {
    const out = toQqbotOutboundText("x is $a+b$ ok", plain);
    assert.match(out, /\[math\]/);
  });

  it("keeps markdown structure for compat", () => {
    const src = "# Title\n\n**bold** and [link](https://qq.com)";
    const out = toQqbotMarkdownContent(src, md);
    assert.match(out, /^# Title/m);
    assert.match(out, /\*\*bold\*\*/);
    assert.match(out, /\[link\]\(https:\/\/qq\.com\)/);
    assert.equal(usesQqbotMarkdown(md), true);
    assert.equal(usesQqbotMarkdown(plain), false);
  });

  it("plain path still strips", () => {
    assert.equal(toQqbotPlainText("**x**", plain), "x");
  });
});
