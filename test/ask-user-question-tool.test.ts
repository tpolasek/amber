import test from "node:test";
import assert from "node:assert/strict";
import {
  ASK_USER_QUESTION_TOOL,
  AskUserQuestionManager,
  formatAskUserQuestionResult,
  parseAskUserQuestionAnswers,
  parseAskUserQuestionInput,
  type AskUserQuestion,
} from "../src/ask-user-question-tool.js";

const questions: AskUserQuestion[] = [
  {
    question: "Which category of framework do you want to use?",
    header: "Framework",
    options: [
      { label: "Frontend", description: "React, Vue, Angular, Svelte", preview: "```\n<App />\n```" },
      { label: "Backend", description: "Express, Fastify, Koa, NestJS" },
    ],
    multiSelect: false,
  },
  {
    question: "Which features do you want to enable?",
    header: "Features",
    options: [
      { label: "Security", description: "Authentication, rate limiting, CORS" },
      { label: "Monitoring", description: "Logging, metrics, error tracking" },
    ],
    multiSelect: true,
  },
];

test("defines the complete AskUserQuestion contract and parses valid questions", () => {
  assert.equal(ASK_USER_QUESTION_TOOL.name, "AskUserQuestion");
  assert.match(ASK_USER_QUESTION_TOOL.description, /Users will always be able to select "Other"/);
  assert.match(ASK_USER_QUESTION_TOOL.description, /side-by-side layout/);
  assert.deepEqual(ASK_USER_QUESTION_TOOL.input_schema.required, ["questions"]);
  assert.deepEqual(parseAskUserQuestionInput({ questions }), { questions });
});

test("defaults multiSelect to false when omitted and rejects non-boolean values", () => {
  const questionSchema = ASK_USER_QUESTION_TOOL.input_schema.properties?.questions as
    | { items?: { required?: string[] } }
    | undefined;
  assert.deepEqual(questionSchema?.items?.required, ["question", "header", "options"]);
  const { multiSelect, ...withoutMultiSelect } = questions[0]!;
  assert.equal(multiSelect, false);
  assert.deepEqual(
    parseAskUserQuestionInput({ questions: [withoutMultiSelect] }),
    { questions: [questions[0]] },
  );
  assert.throws(
    () => parseAskUserQuestionInput({ questions: [{ ...questions[0], multiSelect: "yes" }] }),
    /multiSelect must be a boolean/,
  );
});

test("validates question counts, labels, headers, and uniqueness", () => {
  assert.throws(() => parseAskUserQuestionInput({ questions: [] }), /1-4 questions/);
  assert.throws(() => parseAskUserQuestionInput({ questions: [{ ...questions[0], question: "Missing punctuation" }] }), /end with \?/);
  assert.throws(() => parseAskUserQuestionInput({ questions: [{ ...questions[0], header: "Thirteen chars!" }] }), /12 characters or fewer/);
  assert.throws(() => parseAskUserQuestionInput({
    questions: [{ ...questions[0], options: [questions[0]!.options[0], questions[0]!.options[0]] }],
  }), /option labels must be unique/);
  assert.throws(() => parseAskUserQuestionInput({ questions: [questions[0], questions[0]] }), /Question texts must be unique/);
  assert.throws(() => parseAskUserQuestionInput({
    questions: [{
      ...questions[0],
      options: [{ label: "This label contains far too many words", description: "Long" }, questions[0]!.options[1]],
    }],
  }), /1-5 words/);
});

test("accepts selected and custom answers and formats the reference result prompt", () => {
  const answers = parseAskUserQuestionAnswers({
    [questions[0]!.question]: "Frontend",
    [questions[1]!.question]: "Security, A custom feature",
  }, questions);
  assert.deepEqual(answers, {
    [questions[0]!.question]: "Frontend",
    [questions[1]!.question]: "Security, A custom feature",
  });
  assert.equal(
    formatAskUserQuestionResult(answers),
    `User has answered your questions: "${questions[0]!.question}"="Frontend", "${questions[1]!.question}"="Security, A custom feature". You can now continue with the user's answers in mind.`,
  );
  assert.throws(() => parseAskUserQuestionAnswers({ [questions[0]!.question]: "Frontend" }, questions), /answer is required/);
  assert.throws(() => parseAskUserQuestionAnswers({
    [questions[0]!.question]: "Frontend",
    [questions[1]!.question]: "Security",
    Unknown: "value",
  }, questions), /unknown question/);
});

test("waits for the matching session answer and rejects declines", async () => {
  const manager = new AskUserQuestionManager();
  const controller = new AbortController();
  const pending = manager.waitForAnswers("session", "tool-1", questions, controller.signal);
  const reconnectSnapshot = manager.pending("session");
  assert.deepEqual(reconnectSnapshot, { toolUseId: "tool-1", questions });
  reconnectSnapshot!.questions[0]!.question = "Changed only in the snapshot?";
  assert.equal(manager.pending("session")?.questions[0]?.question, questions[0]?.question);
  assert.throws(() => manager.answer("session", "other-tool", {}), /no longer pending/);
  const submitted = {
    [questions[0]!.question]: "Backend",
    [questions[1]!.question]: "Monitoring",
  };
  assert.deepEqual(manager.answer("session", "tool-1", submitted), submitted);
  assert.deepEqual(await pending, submitted);
  assert.equal(manager.pending("session"), undefined);

  const declined = manager.waitForAnswers("session", "tool-2", questions, controller.signal);
  manager.decline("session", "tool-2");
  await assert.rejects(declined, /User declined to answer questions/);
});

test("aborts a pending question with its model turn", async () => {
  const manager = new AskUserQuestionManager();
  const controller = new AbortController();
  const pending = manager.waitForAnswers("session", "tool-1", questions, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});
