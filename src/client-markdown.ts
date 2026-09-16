import type { MarkdownRenderer } from "./client-types.js";

declare const markdownit: (options: { html: boolean; linkify: boolean; breaks: boolean; typographer: boolean }) => MarkdownRenderer;

export const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });

// markdown-it ships fuzzy links off, so a bare domain like github.com/owner/repo
// stays plain text. Enabling them also linkifies names that merely look like
// domains, because .py, .sh, .rs, .md, .pl, .ml and .cc are real TLDs — a
// filename such as main.py becomes a link to http://main.py. Accepted for reach.
markdown.linkify.set({ fuzzyLink: true });
