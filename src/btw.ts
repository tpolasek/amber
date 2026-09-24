import type { ProviderSystemBlock } from "./types.js";

export interface BtwRequest {
  question: string;
}

export function parseBtwInput(value: unknown): BtwRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Side question must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "question")) {
    throw new Error("Side question contains an unknown field");
  }
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) throw new Error("A question is required");
  if (question.length > 32_000) throw new Error("Questions are limited to 32,000 characters");
  return { question };
}

export function btwSystemReminder(): ProviderSystemBlock {
  return {
    type: "text",
    text: [
      "<system-reminder>",
      "The user is asking a side question about this session (/btw), separate from the main conversation.",
      "Answer it directly in text. You have no tools, the answer is shown to the user only, and neither the question nor the answer is added to the conversation history.",
      "</system-reminder>",
    ].join("\n"),
  };
}
