import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface PreparedLocalImage {
  originalPath: string;
  resolvedPath: string;
  mimeType: string;
  base64: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  originalBytes: number;
  finalBytes: number;
  resized: boolean;
}

export async function loadAndPrepareLocalImage(
  inputPath: string,
  maxDimension = 2048
): Promise<PreparedLocalImage> {
  const resolvedPath = resolve(inputPath);
  const ext = extname(resolvedPath).toLowerCase();
  const mimeType = SUPPORTED_EXTENSIONS[ext];

  if (!mimeType) {
    throw new Error(
      `Unsupported image extension "${ext || "(none)"}" for "${inputPath}". Supported formats: PNG, JPG, JPEG, WebP, GIF.`
    );
  }

  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: "${inputPath}"`);
  }

  const rawBuffer = await readFile(resolvedPath);
  const originalBytes = rawBuffer.byteLength;

  // Keep GIFs untouched to preserve animation frames; inspect/resize static images with sharp.
  if (ext === ".gif") {
    return {
      originalPath: inputPath,
      resolvedPath,
      mimeType,
      base64: rawBuffer.toString("base64"),
      originalBytes,
      finalBytes: originalBytes,
      resized: false,
    };
  }

  const instance = sharp(rawBuffer, { failOn: "none" });
  const meta = await instance.metadata();
  const originalWidth = meta.width;
  const originalHeight = meta.height;

  const needsResize =
    maxDimension > 0 &&
    ((originalWidth !== undefined && originalWidth > maxDimension) ||
      (originalHeight !== undefined && originalHeight > maxDimension));

  if (!needsResize) {
    return {
      originalPath: inputPath,
      resolvedPath,
      mimeType,
      base64: rawBuffer.toString("base64"),
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      originalBytes,
      finalBytes: originalBytes,
      resized: false,
    };
  }

  const pipeline = sharp(rawBuffer, { failOn: "none" }).resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });

  let outBuffer: Buffer;
  let outMimeType = mimeType;
  if (ext === ".png") {
    outBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
    outMimeType = "image/png";
  } else if (ext === ".webp") {
    outBuffer = await pipeline.webp({ quality: 88 }).toBuffer();
    outMimeType = "image/webp";
  } else {
    outBuffer = await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    outMimeType = "image/jpeg";
  }

  const outMeta = await sharp(outBuffer).metadata();

  return {
    originalPath: inputPath,
    resolvedPath,
    mimeType: outMimeType,
    base64: outBuffer.toString("base64"),
    originalWidth,
    originalHeight,
    width: outMeta.width,
    height: outMeta.height,
    originalBytes,
    finalBytes: outBuffer.byteLength,
    resized: true,
  };
}

export function sanitizeFilenameSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 64);
  return cleaned || "node";
}

export async function saveExportedScreenshot(
  base64: string,
  options: {
    nodeId: string;
    nodeName: string;
    format: "PNG" | "JPG" | "WEBP";
    savePath?: string;
  }
): Promise<{ filePath: string; byteLength: number }> {
  const ext = options.format.toLowerCase();
  const targetPath = options.savePath
    ? resolve(options.savePath)
    : join(
        tmpdir(),
        "use-mastergo-mcp",
        "screenshots",
        `${sanitizeFilenameSegment(options.nodeName)}_${sanitizeFilenameSegment(options.nodeId)}_${Date.now()}.${ext}`
      );

  await mkdir(dirname(targetPath), { recursive: true });
  const buffer = Buffer.from(base64, "base64");
  await writeFile(targetPath, buffer);
  return {
    filePath: targetPath,
    byteLength: buffer.byteLength,
  };
}
