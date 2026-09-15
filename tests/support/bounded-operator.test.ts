import assert from "node:assert/strict";
import test from "node:test";

import { boundedTestOperator } from "./bounded-operator.ts";

test("test operator stops an unbounded retry double", async () => {
  const operator = boundedTestOperator({
    write() {},
    async pause() {
      return "";
    },
  });

  for (let attempt = 0; attempt < 5; attempt += 1)
    assert.equal(await operator.pause("retry"), "");
  await assert.rejects(operator.pause("retry"), /retry limit exceeded/u);
});
