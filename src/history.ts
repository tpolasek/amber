import type { Message, ProviderMessage, SessionCompaction, SessionInvokedSkill } from "./types.js";
import { compactedSkillInstructions } from "./skill-tool.js";
import { imageBlock } from "./message-images.js";

const SUMMARY_PREFIX = "The following is a generated summary of the earlier conversation. Use it as user-provided context when continuing the session.\n\n";

export function isModelMessage(message: Message): boolean {
  return message.kind === undefined || message.kind === "chat";
}

export function isProviderMessage(message: Message): boolean {
  return isModelMessage(message)
    || message.kind === "tool-result"
    || message.kind === "skill"
    || message.kind === "agent-notification";
}

export function buildProviderHistory(
  messages: Message[],
  excludedMessageId?: string,
  compaction?: SessionCompaction,
  invokedSkills?: SessionInvokedSkill[],
): ProviderMessage[] {
  const storedBoundaryIndex = compaction
    ? messages.findIndex((message) => message.id === compaction.throughMessageId)
    : -1;
  const bannerIndex = storedBoundaryIndex >= 0
    ? messages.findIndex((message, index) => index > storedBoundaryIndex && message.kind === "compact-banner")
    : -1;
  const boundaryIndex = bannerIndex >= 0 ? bannerIndex : storedBoundaryIndex;
  const activeMessages = boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
  const history: ProviderMessage[] = [];
  for (const message of activeMessages
    .filter((candidate) => candidate.id !== excludedMessageId && candidate.status === "complete" && isProviderMessage(candidate))) {
    const providerMessage: ProviderMessage = {
      role: message.role,
      content: message.kind === "tool-result" && message.toolUseId
        ? [{
            type: "tool_result",
            tool_use_id: message.toolUseId,
            ...(message.images?.length
              ? {
                  content: [
                    ...message.images.map(imageBlock),
                    ...(message.contentBlocks ?? [{ type: "text" as const, text: message.content }]),
                  ],
                }
              : { content: message.contentBlocks ?? message.content }),
            ...(message.contentBlocks && !message.toolError ? {} : { is_error: message.toolError === true }),
          }]
        : message.role === "assistant" && (message.thinking || message.toolCalls?.length)
          ? [
              ...(message.thinking && message.thinkingSignature
                ? [{
                    type: "thinking" as const,
                    thinking: message.thinking,
                    signature: message.thinkingSignature,
                    ...(message.thinkingProvider ? { provider: message.thinkingProvider } : {}),
                  }]
                : []),
              ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
              ...(message.toolCalls ?? []).map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ]
          : message.images?.length
            ? [
                ...message.images.map(imageBlock),
                ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
              ]
            : message.content,
    };
    const previous = history.at(-1);
    if (
      (message.kind === "tool-result" || message.kind === "skill")
      && previous?.role === "user" && Array.isArray(previous.content) && Array.isArray(providerMessage.content)
    ) {
      previous.content.push(...providerMessage.content);
    } else if ((message.kind === "skill" || message.kind === "agent-notification") && previous?.role === "user") {
      history.pop();
      history.push({
        role: "user",
        content: Array.isArray(previous.content)
          ? [...previous.content, { type: "text" as const, text: message.content }]
          : [{ type: "text" as const, text: previous.content }, { type: "text" as const, text: message.content }],
      });
    } else {
      history.push(providerMessage);
    }
  }

  if (compaction && boundaryIndex >= 0) {
    const activeSkillNames = new Set(
      activeMessages.flatMap((message) => (message.kind === "skill" && message.skillName ? [message.skillName] : [])),
    );
    const reinjected = compactedSkillInstructions(invokedSkills ?? [], activeSkillNames);
    const summary = `${SUMMARY_PREFIX}${compaction.summary}`;
    history.unshift(reinjected.length
      ? {
          role: "user",
          content: [
            { type: "text", text: summary },
            {
              type: "text",
              text: `<system-reminder>\nThe following skill instructions were loaded earlier in this session and remain in effect:\n\n${
                reinjected.map((content) => content.trim()).join("\n\n")}\n</system-reminder>`,
            },
          ],
        }
      : { role: "user", content: summary });
  }
  markTrailingCacheControl(history);
  return history;
}

function markTrailingCacheControl(history: ProviderMessage[]): void {
  const last = history.at(-1);
  if (last?.role !== "user" || !Array.isArray(last.content)) return;
  const block = last.content.at(-1);
  if (block && (block.type === "text" || block.type === "tool_result" || block.type === "image")) {
    block.cache_control = { type: "ephemeral" };
  }
}
