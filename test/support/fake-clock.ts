/** Deterministic clock + sleep pair: `sleep` advances time instead of waiting. */
export class FakeClock {
  readonly sleeps: number[] = [];

  constructor(private current = 1_700_000_000_000) {}

  readonly now = (): number => this.current;

  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.current += ms;
  };

  advance(ms: number): void {
    this.current += ms;
  }
}
