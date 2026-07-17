import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  classifyFileType,
  fileTypeToKind,
  kindFromMimeOrName,
  readLocalFileBase64,
  sanitizeFileName,
} from "./media.ts";

describe("qqbot media helpers", () => {
  it("classifies image/video/voice/file", () => {
    assert.equal(classifyFileType("a.png", "image/png"), 1);
    assert.equal(classifyFileType("a.mp4", "video/mp4"), 2);
    assert.equal(classifyFileType("a.mp3", "audio/mpeg"), 3);
    assert.equal(classifyFileType("a.pdf", "application/pdf"), 4);
    assert.equal(fileTypeToKind(1), "image");
    assert.equal(fileTypeToKind(4), "document");
    assert.equal(kindFromMimeOrName("image/jpeg", "x.jpg"), "image");
  });

  it("sanitizes file names", () => {
    assert.equal(sanitizeFileName("hello world.png"), "hello_world.png");
  });

  it("reads local file as base64", async () => {
    const dir = join(tmpdir(), `pi-qqbot-media-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "hello-qqbot");
    try {
      const { base64, byteSize, fileName } = await readLocalFileBase64(path);
      assert.equal(fileName, "sample.txt");
      assert.equal(byteSize, 11);
      assert.equal(Buffer.from(base64, "base64").toString("utf8"), "hello-qqbot");
      const again = await readFile(path, "utf8");
      assert.equal(again, "hello-qqbot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
