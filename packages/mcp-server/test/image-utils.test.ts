import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAndPrepareLocalImage,
  sanitizeFilenameSegment,
  saveExportedScreenshot,
} from "../src/image-utils.js";

describe("image-utils", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized PNG while keeping small PNG untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "use-mastergo-img-test-"));
    tempDirs.push(dir);

    const bigPath = join(dir, "big.png");
    await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 4,
        background: { r: 20, g: 120, b: 240, alpha: 1 },
      },
    })
      .png()
      .toFile(bigPath);

    const resized = await loadAndPrepareLocalImage(bigPath, 400);
    expect(resized.resized).toBe(true);
    expect(resized.originalWidth).toBe(1200);
    expect(resized.originalHeight).toBe(600);
    expect(resized.width).toBe(400);
    expect(resized.height).toBe(200);
    expect(resized.mimeType).toBe("image/png");

    const untouched = await loadAndPrepareLocalImage(bigPath, 2048);
    expect(untouched.resized).toBe(false);
    expect(untouched.width).toBe(1200);
    expect(untouched.height).toBe(600);
  });

  it("rejects unsupported file extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "use-mastergo-img-test-"));
    tempDirs.push(dir);
    await expect(
      loadAndPrepareLocalImage(join(dir, "notes.txt"))
    ).rejects.toThrow(/Unsupported image extension/);
  });

  it("saves exported screenshot bytes to requested savePath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "use-mastergo-shot-test-"));
    tempDirs.push(dir);

    const pngBuf = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const savePath = join(dir, "nested", "frame.png");
    const saved = await saveExportedScreenshot(pngBuf.toString("base64"), {
      nodeId: "1:2",
      nodeName: "Hero / Card?",
      format: "PNG",
      savePath,
    });

    expect(saved.filePath).toBe(savePath);
    expect(saved.byteLength).toBe(pngBuf.byteLength);
    const written = await readFile(savePath);
    expect(written.equals(pngBuf)).toBe(true);
    expect(sanitizeFilenameSegment("Hero / Card?")).toBe("Hero-_-Card");
  });
});
