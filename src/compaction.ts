import { BASE_COMPACT_PROMPT } from "./prompts.js";
import type { LlmProvider, ProviderMessage } from "./types.js";

export async function generateCompactionSummary(
  provider: LlmProvider,
  history: ProviderMessage[],
  signal: AbortSignal,
  onProgress?: (generatedCharacters: number) => void,
): Promise<string> {
  const request = [...history, { role: "user" as const, content: BASE_COMPACT_PROMPT }];
  let output = "";
  for await (const event of provider.stream(request, signal, { system: null })) {
    if (event.type === "delta") {
      output += event.text;
      onProgress?.(output.length);
    }
  }

  const summary = formatCompactionSummary(output);
  if (!summary) throw new Error("The model returned an empty compaction summary");
  return summary;
}

export function estimateHistoryTokens(history: ProviderMessage[]): number {
  return history.reduce((total, message) => {
    const characters = typeof message.content === "string"
      ? message.content.length
      : message.content.reduce((sum, block) => {
          if (block.type === "thinking") return sum + block.thinking.length;
          if (block.type === "text") return sum + block.text.length;
          if (block.type === "tool_result") return sum + block.content.length;
          return sum + JSON.stringify(block.input).length;
        }, 0);
    return total + Math.ceil(characters / 4) + 4;
  }, 0);
}

export function shouldAutoCompact(
  compactTokens: number | undefined,
  measuredTokens: number,
  history: ProviderMessage[],
): boolean {
  return compactTokens !== undefined
    && Math.max(measuredTokens, estimateHistoryTokens(history)) >= compactTokens;
}

export function formatCompactionBanner(beforeTokens: number, afterTokens: number, coveredMessageCount: number): string {
  const delta = beforeTokens - afterTokens;
  const percentage = beforeTokens > 0 ? Math.round(Math.abs(delta) / beforeTokens * 100) : 0;
  const change = delta >= 0
    ? `Reduction: ≈${formatNumber(delta)} tokens (${percentage}%)`
    : `Increase: ≈${formatNumber(Math.abs(delta))} tokens (${percentage}%)`;
  return [
    "Context compacted here",
    `Estimated context: ≈${formatNumber(beforeTokens)} → ≈${formatNumber(afterTokens)} tokens`,
    change,
    `${formatNumber(coveredMessageCount)} earlier messages remain visible`,
  ].join(" · ");
}

export function formatCompactionSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(summaryMatch[1] ?? "").trim()}`);
  }
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
