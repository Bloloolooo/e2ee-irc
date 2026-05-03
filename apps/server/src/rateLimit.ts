const WINDOW_MS = 5_000;
const MAX_MESSAGES = 20;

export class ConnectionRateLimiter {
  private timestamps: number[] = [];

  allow(now = Date.now()): boolean {
    const windowStart = now - WINDOW_MS;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > windowStart);

    if (this.timestamps.length >= MAX_MESSAGES) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}
