import type { ImageMediaType, MessageImage, ProviderImageBlock, ProviderMessage } from "./types.js";

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 600;
/** Transport cap for message endpoints: 64 MiB raw is roughly 86 MB base64. */
export const MAX_MESSAGE_BODY_BYTES = 100 * 1024 * 1024;
/** Rough per-image character cost (≈1,600 tokens) used by the compaction estimate. */
export const imageCharacterEstimate = 6_400;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const EXTENSION_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMediaTypeForPath(path: string): ImageMediaType | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXTENSION_MEDIA_TYPES[path.slice(dot).toLowerCase()];
}

export function sniffImageMediaType(buffer: Buffer): ImageMediaType | undefined {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export function imageBlock(image: MessageImage): ProviderImageBlock {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
}

export function imageDataUrl(image: MessageImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function parseMessageImages(input: unknown): { images: MessageImage[] } | { error: string } {
  if (input === undefined || input === null) return { images: [] };
  if (!Array.isArray(input)) return { error: "images must be an array" };
  if (input.length > MAX_IMAGES_PER_MESSAGE) {
    return { error: `A message accepts at most ${MAX_IMAGES_PER_MESSAGE} images` };
  }
  const images: MessageImage[] = [];
  let totalBytes = 0;
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) return { error: "Each image must be an object with mediaType and data" };
    const candidate = entry as { mediaType?: unknown; data?: unknown };
    if (typeof candidate.mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(candidate.mediaType as ImageMediaType)) {
      return { error: `Image media type must be one of ${IMAGE_MEDIA_TYPES.join(", ")}` };
    }
    if (typeof candidate.data !== "string" || !BASE64_PATTERN.test(candidate.data)) {
      return { error: "Image data must be a base64 string" };
    }
    const bytes = Math.floor((candidate.data.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      return { error: `Each image must be at most ${formatBytes(MAX_IMAGE_BYTES)}` };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { error: `Images must total at most ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} per message` };
    }
    images.push({ mediaType: candidate.mediaType as ImageMediaType, data: candidate.data });
  }
  return { images };
}

/** Replaces image blocks with a short placeholder so side channels (titles) never carry base64. */
export function stripProviderImages(history: ProviderMessage[]): ProviderMessage[] {
  return history.map((message) => {
    if (typeof message.content !== "string" && message.content.some((block) => block.type === "image" || block.type === "tool_result")) {
      return {
        ...message,
        content: message.content.map((block) => block.type === "image"
          ? { type: "text" as const, text: "[image attached]" }
          : block.type === "tool_result" && Array.isArray(block.content)
            ? {
                ...block,
                content: block.content.map((part) => part.type === "image"
                  ? { type: "text" as const, text: "[image attached]" }
                  : part),
              }
            : block),
      };
    }
    return message;
  });
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
