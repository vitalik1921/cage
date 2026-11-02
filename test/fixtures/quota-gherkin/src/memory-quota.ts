/** @implements Quota */
export class MemoryQuota {
  private readonly remaining: Map<string, number>;

  constructor(initial: Record<string, number>) {
    this.remaining = new Map(Object.entries(initial));
  }

  async take(accountId: string): Promise<boolean> {
    const left = this.remaining.get(accountId) ?? 0;
    if (left <= 0) return false;
    this.remaining.set(accountId, left - 1);
    return true;
  }
}
