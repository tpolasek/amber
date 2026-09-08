import type { MarkdownRenderer } from "./client-types.js";

declare const markdownit: (options: { html: boolean; linkify: boolean; breaks: boolean; typographer: boolean }) => MarkdownRenderer;

export const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
