export const STREAMING_THINKING_TICK_MS = 50;
export const STREAMING_THINKING_BOTTOM_THRESHOLD_PX = 8;
const STREAMING_THINKING_MIN_WPS = 5;
const STREAMING_THINKING_MAX_WPS = 120;
const STREAMING_THINKING_DEFAULT_WPS = 30;

export class StreamingThinkingReveal {
  private fullText = "";
  private displayedLength = 0;
  private rate = STREAMING_THINKING_DEFAULT_WPS;
  private credit = 0;
  private lastSample: { length: number; time: number } | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onReveal: (displayed: string) => void) {}

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.tick(), STREAMING_THINKING_TICK_MS);
  }

  update(thinking: string, now = Date.now()): void {
    const previousSample = this.lastSample;
    if (previousSample !== null) {
      const elapsedSeconds = (now - previousSample.time) / 1_000;
      if (elapsedSeconds > 0.001) {
        const addedWords = countStreamingWords(thinking.slice(previousSample.length));
        if (addedWords > 0) {
          const sample = clampStreamingRate(addedWords / elapsedSeconds);
          this.rate = clampStreamingRate(this.rate * 0.6 + sample * 0.4);
        }
      }
    }
    this.fullText = thinking;
    this.lastSample = { length: thinking.length, time: now };
  }

  tick(elapsedMs = STREAMING_THINKING_TICK_MS): void {
    if (this.displayedLength >= this.fullText.length) return;
    this.credit += (this.rate * elapsedMs) / 1_000;
    let advanced = false;
    while (this.credit >= 1 && this.displayedLength < this.fullText.length) {
      this.displayedLength = advanceStreamingWord(this.fullText, this.displayedLength);
      this.credit -= 1;
      advanced = true;
    }
    if (advanced) this.onReveal(this.fullText.slice(0, this.displayedLength));
  }

  stop(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }
}

export class BottomScrollPin {
  private followingBottom = true;

  update(scrollTop: number, clientHeight: number, scrollHeight: number): void {
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    this.followingBottom = distanceFromBottom <= STREAMING_THINKING_BOTTOM_THRESHOLD_PX;
  }

  shouldFollowBottom(): boolean {
    return this.followingBottom;
  }

  reset(): void {
    this.followingBottom = true;
  }
}

export function countStreamingWords(value: string): number {
  let count = 0;
  let inWord = false;
  for (const character of value) {
    if (isStreamingWhitespace(character)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count += 1;
    }
  }
  return count;
}

export function advanceStreamingWord(full: string, from: number): number {
  let index = from;
  while (index < full.length && isStreamingWhitespace(full[index]!)) index += 1;
  while (index < full.length && !isStreamingWhitespace(full[index]!)) index += 1;
  return index;
}

function isStreamingWhitespace(character: string): boolean {
  return character === " " || character === "\n" || character === "\t" || character === "\r";
}

function clampStreamingRate(value: number): number {
  return Math.min(STREAMING_THINKING_MAX_WPS, Math.max(STREAMING_THINKING_MIN_WPS, value));
}
