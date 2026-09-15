import type { OperatorIO } from "../../src/run/contracts.ts";

const MAX_RETRIES = 5;
const MAX_PAUSES = 20;

/** Keep test doubles finite when production code deliberately allows operator retries. */
export function boundedTestOperator(operator: OperatorIO): OperatorIO {
  let pauses = 0;
  let retries = 0;
  return {
    write(message) {
      operator.write(message);
    },
    async pause(message) {
      pauses += 1;
      if (pauses > MAX_PAUSES)
        throw new Error(`Test operator pause limit exceeded (${MAX_PAUSES})`);
      const response = await operator.pause(message);
      if (response === "") {
        retries += 1;
        if (retries > MAX_RETRIES)
          throw new Error(
            `Test operator retry limit exceeded (${MAX_RETRIES})`,
          );
      } else {
        retries = 0;
      }
      return response;
    },
  };
}
