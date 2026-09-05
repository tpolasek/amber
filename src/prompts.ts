export const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`;

export const BASE_COMPACT_PROMPT = `Create a concise but complete continuation summary of the conversation above. Preserve information needed to resume the current work accurately, and give recent user instructions priority over older context.

Include:
1. Current objective and the user's explicit requirements, constraints, and corrections.
2. Decisions made and work already completed.
3. Relevant repository state: changed or important files, key symbols, interfaces, commands, and test results. Include exact text or code only when it is necessary to continue correctly.
4. Errors encountered, their causes, and any lessons that affect the remaining work.
5. Remaining requested tasks, blockers, and the immediate next action. Do not invent follow-up work when the request is complete.
6. Any loaded skill instructions or user-provided summarization instructions that must remain active.

Return only the summary. Do not include private analysis, a preamble, or a retrospective of irrelevant completed work.`;
