import type { ToolDefinition } from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12;

export const ASK_USER_QUESTION_TOOL_PROMPT = `Ask the user for a requirement, preference, or implementation decision that materially affects the work.

Provide two to four clear options; the UI adds an Other choice automatically. Put a recommended option first and suffix its label with "(Recommended)". Set multiSelect only when choices may be combined.

In plan mode, use this tool to resolve requirements or tradeoffs before submitting the plan. Use ExitPlanMode—not this tool or prose—to request plan approval.

The optional preview field renders Markdown beside single-select options. Use it only when a concrete mockup, code sample, diagram, or configuration materially helps the user compare choices. Previews are unavailable for multi-select questions.`;

export const ASK_USER_QUESTION_TOOL: ToolDefinition = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: ASK_USER_QUESTION_TOOL_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        description: "Questions to ask the user (1-4 questions)",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: {
              type: "string",
              description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
            },
            header: {
              type: "string",
              maxLength: ASK_USER_QUESTION_TOOL_CHIP_WIDTH,
              description: `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              description: "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: {
                    type: "string",
                    description: "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
                  },
                  description: {
                    type: "string",
                    description: "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
                  },
                  preview: {
                    type: "string",
                    description: "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
                  },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: {
              type: "boolean",
              default: false,
              description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
}

export type AskUserQuestionAnswers = Record<string, string>;

export function parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionInput {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    throw new Error("AskUserQuestion questions must contain 1-4 questions");
  }
  const questions = input.questions.map((value, questionIndex) => parseQuestion(value, questionIndex));
  if (new Set(questions.map((question) => question.question)).size !== questions.length) {
    throw new Error("Question texts must be unique, option labels must be unique within each question");
  }
  return { questions };
}

export function parseAskUserQuestionAnswers(
  value: unknown,
  questions: AskUserQuestion[],
): AskUserQuestionAnswers {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("answers must be an object keyed by question text");
  }
  const input = value as Record<string, unknown>;
  const expected = new Set(questions.map((question) => question.question));
  if (Object.keys(input).some((question) => !expected.has(question))) {
    throw new Error("answers contains an unknown question");
  }
  const answers: AskUserQuestionAnswers = {};
  for (const question of questions) {
    const answer = input[question.question];
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error(`An answer is required for \"${question.question}\"`);
    }
    answers[question.question] = answer.trim();
  }
  return answers;
}

export function formatAskUserQuestionResult(answers: AskUserQuestionAnswers): string {
  const answersText = Object.entries(answers)
    .map(([question, answer]) => `\"${question}\"=\"${answer}\"`)
    .join(", ");
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}

function parseQuestion(value: unknown, questionIndex: number): AskUserQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Question ${questionIndex + 1} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const question = requiredString(input.question, `Question ${questionIndex + 1} question`);
  if (!question.endsWith("?")) throw new Error(`Question \"${question}\" must end with ?`);
  const header = requiredString(input.header, `Question ${questionIndex + 1} header`);
  if (header.length > ASK_USER_QUESTION_TOOL_CHIP_WIDTH) {
    throw new Error(`Question \"${question}\" header must be ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} characters or fewer`);
  }
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4) {
    throw new Error(`Question \"${question}\" must contain 2-4 options`);
  }
  const options = input.options.map((option, optionIndex) => parseOption(option, question, optionIndex));
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new Error("Question texts must be unique, option labels must be unique within each question");
  }
  const multiSelect = input.multiSelect === undefined ? false : input.multiSelect;
  if (typeof multiSelect !== "boolean") {
    throw new Error(`Question \"${question}\" multiSelect must be a boolean`);
  }
  return { question, header, options, multiSelect };
}

function parseOption(value: unknown, question: string, optionIndex: number): AskUserQuestionOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Option ${optionIndex + 1} in question \"${question}\" must be an object`);
  }
  const input = value as Record<string, unknown>;
  const label = requiredString(input.label, `Option ${optionIndex + 1} label`);
  if (label.trim().split(/\s+/).length > 5) {
    throw new Error(`Option \"${label}\" in question \"${question}\" must be 1-5 words`);
  }
  const description = requiredString(input.description, `Option \"${label}\" description`);
  if (input.preview !== undefined && typeof input.preview !== "string") {
    throw new Error(`Option \"${label}\" preview must be a string`);
  }
  return {
    label,
    description,
    ...(typeof input.preview === "string" ? { preview: input.preview } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

interface PendingQuestionRequest {
  toolUseId: string;
  questions: AskUserQuestion[];
  resolve: (answers: AskUserQuestionAnswers) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class AskUserQuestionManager {
  #pending = new Map<string, PendingQuestionRequest>();

  pending(sessionId: string): { toolUseId: string; questions: AskUserQuestion[] } | undefined {
    const pending = this.#pending.get(sessionId);
    if (!pending) return undefined;
    return { toolUseId: pending.toolUseId, questions: structuredClone(pending.questions) };
  }

  waitForAnswers(
    sessionId: string,
    toolUseId: string,
    questions: AskUserQuestion[],
    signal: AbortSignal,
  ): Promise<AskUserQuestionAnswers> {
    if (this.#pending.has(sessionId)) throw new Error("This session already has a pending question");
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#settle(sessionId, toolUseId, undefined, abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(sessionId, {
        toolUseId,
        questions,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      });
    });
  }

  answer(sessionId: string, toolUseId: string, value: unknown): AskUserQuestionAnswers {
    const pending = this.#get(sessionId, toolUseId);
    const answers = parseAskUserQuestionAnswers(value, pending.questions);
    this.#settle(sessionId, toolUseId, answers);
    return answers;
  }

  decline(sessionId: string, toolUseId: string): void {
    this.#get(sessionId, toolUseId);
    this.#settle(sessionId, toolUseId, undefined, new Error("User declined to answer questions"));
  }

  stopAll(): void {
    for (const [sessionId, pending] of this.#pending) {
      this.#settle(sessionId, pending.toolUseId, undefined, abortError());
    }
  }

  #get(sessionId: string, toolUseId: string): PendingQuestionRequest {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) throw new Error("Question request is no longer pending");
    return pending;
  }

  #settle(
    sessionId: string,
    toolUseId: string,
    answers?: AskUserQuestionAnswers,
    error?: Error,
  ): void {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) return;
    this.#pending.delete(sessionId);
    pending.removeAbortListener();
    if (error) pending.reject(error);
    else pending.resolve(answers ?? {});
  }
}

function abortError(): Error {
  const error = new Error("Question request aborted");
  error.name = "AbortError";
  return error;
}
