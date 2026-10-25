export interface BlockSplitter {
  /** Feeds a delta; returns blocks closed by it. */
  push(delta: string): string[];
  /** Returns and clears the pending remainder. */
  finish(): string;
}

interface FenceState { marker: string; length: number }

export function createBlockSplitter(): BlockSplitter {
  let buffer = "";
  let pending: string[] = [];
  let fenceLines: string[] = [];
  let fence: FenceState | null = null;
  const closed: string[] = [];

  const fenceOf = (line: string): FenceState | null => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    return match ? { marker: match[1]![0]!, length: match[1]!.length } : null;
  };
  const closePending = () => {
    while (pending.length > 0 && pending[0] === "") pending = pending.slice(1);
    if (pending.length > 0) closed.push(pending.join("\n"));
    pending = [];
  };

  return {
    push(delta: string): string[] {
      closed.length = 0;
      buffer += delta;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (fence) {
          fenceLines.push(line);
          const closing = fenceOf(line);
          if (closing && closing.marker === fence.marker && closing.length >= fence.length) {
            closed.push(fenceLines.join("\n"));
            fenceLines = [];
            fence = null;
          }
          continue;
        }
        const opening = fenceOf(line);
        if (opening) {
          closePending();
          fence = opening;
          fenceLines = [line];
        } else if (line.trim() === "") {
          closePending();
        } else {
          pending.push(line);
        }
      }
      if (fence) {
        const closing = fenceOf(buffer);
        if (closing && closing.marker === fence.marker && closing.length >= fence.length) {
          fenceLines.push(buffer);
          closed.push(fenceLines.join("\n"));
          fenceLines = [];
          fence = null;
          buffer = "";
        }
      } else if (fenceOf(buffer) !== null) {
        closePending();
      }
      const out = [...closed];
      closed.length = 0;
      return out;
    },
    finish(): string {
      const parts: string[] = [];
      if (fence) {
        parts.push(...fenceLines, buffer);
        fenceLines = [];
        fence = null;
        buffer = "";
      } else if (buffer !== "") {
        pending.push(buffer);
        buffer = "";
      }
      closePending();
      parts.push(...closed);
      closed.length = 0;
      return parts.join("\n");
    },
  };
}
