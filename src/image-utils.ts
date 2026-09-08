import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export interface ReadImageOptions {
  maxDimension?: number;
  quality?: number;
}

export interface ReadImageResult {
  mimeType: string;
  sizeBytes: number;
  extension: string;
  base64Data: string;
  dataUrl: string;
}

const SUPPORTED_IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(Object.keys(SUPPORTED_IMAGE_MIMES));

export function isSupportedImageExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

export function getImageMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_MIMES[ext] ?? "application/octet-stream";
}

const MAX_IMAGE_FILE_SIZE = 15 * 1024 * 1024; // 15MB limit

/**
 * Reads an image file safely from disk, verifies its format and size,
 * and encodes it into standard Base64 data for multimodal MCP consumption.
 */
export async function readImageFile(
  absolutePath: string,
  _options: ReadImageOptions = {},
): Promise<ReadImageResult> {
  const ext = extname(absolutePath).toLowerCase();
  const mimeType = SUPPORTED_IMAGE_MIMES[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported image format: ${ext || "unknown"}. Supported formats: ${Object.keys(SUPPORTED_IMAGE_MIMES).join(", ")}`,
    );
  }

  const fileStat = await stat(absolutePath);
  if (fileStat.isDirectory()) {
    throw new Error(`Path is a directory, not an image file: ${absolutePath}`);
  }

  if (fileStat.size > MAX_IMAGE_FILE_SIZE) {
    throw new Error(
      `Image file exceeds maximum allowable size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB > 15 MB). Please use a smaller image.`,
    );
  }

  const buffer = await readFile(absolutePath);
  const base64Data = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  return {
    mimeType,
    sizeBytes: fileStat.size,
    extension: ext,
    base64Data,
    dataUrl,
  };
}
