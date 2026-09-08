import { diffLineClass } from "./tool-display.js";

export function renderDiff(container: HTMLElement, diff: string): void {
  const lines = diff.split("\n");
  lines.forEach((line, index) => {
    const span = document.createElement("span");
    span.className = diffLineClass(line);
    span.textContent = line || " ";
    container.append(span);
    if (index < lines.length - 1) container.append("\n");
  });
}
