import type { Clock } from "../run/contracts.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
