/** Small transport batches; first text stays immediate, later text waits at most one interval. */
export class TextDeltaBuffer {
  private buffer = '';
  private first = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private failed = false;

  constructor(
    private readonly send: (delta: string) => Promise<void> | void,
    private readonly delayMs = 30,
    private readonly maxChars = 1024,
  ) {}

  async push(delta: string): Promise<void> {
    if (!delta) return;
    this.buffer += delta;
    if (this.first || this.buffer.length >= this.maxChars) {
      this.first = false;
      await this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        // The stream loop observes failures on the next flush; no detached rejected promise.
        void this.flush().catch(() => {});
      }, this.delayMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const delta = this.buffer;
    this.buffer = '';
    if (delta) {
      this.sending = this.sending.then(async () => {
        if (this.failed) return;
        try {
          await this.send(delta);
        } catch (error) {
          this.failed = true;
          this.failure = error;
        }
      });
    }
    await this.sending;
    if (this.failed) throw this.failure;
  }

  /** Always cancel the timer when a turn leaves, even if the transport has failed. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
