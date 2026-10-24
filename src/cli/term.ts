/** Append-only terminal writer. All output batches until flushed; the only
 * in-place rewrite is a single status line, so a slow link carries few, full
 * packets and never a repaint. */
export class Terminal {
  private buffer = "";
  private timer: NodeJS.Timeout | null = null;
  private statusText: string | null = null;
  readonly color: boolean;

  constructor(
    private readonly out: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> =
      process.stdout as NodeJS.WriteStream,
    private readonly flushIntervalMs = 250,
    private readonly maxBufferBytes = 4096,
  ) {
    this.color = this.out.isTTY === true && process.env.NO_COLOR === undefined;
  }

  get interactive(): boolean { return this.out.isTTY === true; }
  get columns(): number {
    const columns = this.out.columns;
    return columns && columns > 0 ? columns : 80;
  }

  style(text: string, codes: string): string {
    return this.color ? `\x1b[${codes}m${text}\x1b[0m` : text;
  }

  append(text: string): void {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer, "utf8") >= this.maxBufferBytes) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  line(text = ""): void { this.append(`${text}\n`); }

  status(text: string | null): void {
    if (!this.interactive || this.statusText === text) return;
    this.flush(); // pending content must land above the status line
    if (text === null) this.clearStatus();
    this.statusText = text;
    this.paintStatus();
  }

  suppressStatus(): void {
    if (this.statusText === null) return;
    this.clearStatus();
    this.statusText = null;
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer === "") return;
    this.clearStatus();
    this.out.write(this.buffer);
    this.buffer = "";
    this.paintStatus();
  }

  end(): void {
    this.status(null);
    this.flush();
  }

  private clearStatus(): void {
    if (this.statusText !== null) this.out.write("\r\x1b[K");
  }

  private paintStatus(): void {
    if (this.statusText !== null) this.out.write(`\r\x1b[K${this.statusText}`);
  }
}
