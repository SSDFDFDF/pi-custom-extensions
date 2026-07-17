import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMultimodalImageAttachment } from "./media.ts";

describe("isMultimodalImageAttachment", () => {
  it("treats kind=image as multimodal", () => {
    assert.equal(
      isMultimodalImageAttachment({ kind: "image", path: "/tmp/x.bin" }),
      true,
    );
  });

  it("treats image/* mime documents as multimodal", () => {
    assert.equal(
      isMultimodalImageAttachment({
        kind: "document",
        path: "/tmp/shot.png",
        mimeType: "image/png",
      }),
      true,
    );
  });

  it("treats image extensions as multimodal even without mime", () => {
    assert.equal(
      isMultimodalImageAttachment({
        kind: "document",
        path: "/tmp/a.JPEG",
        fileName: "a.JPEG",
      }),
      true,
    );
  });

  it("keeps pdf as non-image", () => {
    assert.equal(
      isMultimodalImageAttachment({
        kind: "document",
        path: "/tmp/a.pdf",
        mimeType: "application/pdf",
      }),
      false,
    );
  });
});
