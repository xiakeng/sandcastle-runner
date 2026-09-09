import { createInterface } from "node:readline/promises";

import type { OperatorIO } from "../run/contracts.ts";

export class TerminalOperator implements OperatorIO {
  write(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  async pause(message: string): Promise<string | null> {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await terminal.question(`${message}\n> `);
    } catch {
      return null;
    } finally {
      terminal.close();
    }
  }
}
