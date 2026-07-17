import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expandSlashFaces,
  faceFromSlash,
  formatProgressFaceText,
  formatFriendlyNotice,
  preserveFaceContent,
  containsFaceMarkup,
} from "./faces.ts";

describe("qqbot faces slash codes", () => {
  it("maps /fendou classic code", () => {
    assert.equal(faceFromSlash("fendou"), "💪");
    assert.equal(faceFromSlash("/fendou"), "💪");
    assert.equal(faceFromSlash("奋斗"), "💪");
  });

  it("expands inline slash faces", () => {
    assert.equal(expandSlashFaces("加油/fendou"), "加油💪");
    assert.equal(expandSlashFaces("/wx 你好"), "😊 你好");
    assert.equal(expandSlashFaces("/微笑"), "😊");
  });

  it("does not eat control commands", () => {
    assert.equal(expandSlashFaces("/abort"), "/abort");
    assert.equal(expandSlashFaces("/stop now"), "/stop now");
    assert.equal(faceFromSlash("abort"), undefined);
  });

  it("converts faceType tags and slash together", () => {
    const raw =
      '<faceType=1,faceId="302",ext="x"> /fendou 冲';
    assert.equal(containsFaceMarkup(raw), true);
    assert.equal(preserveFaceContent(raw), "🙇 💪 冲");
  });

  it("progress / notice use unicode", () => {
    assert.equal(formatProgressFaceText("bash"), "💪 正在执行中");
    assert.match(formatFriendlyNotice("ok", "ok"), /😊/);
  });
});
