import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";

test.afterEach(cleanupTempRoots);

test("parent and issue selectors are mutually exclusive and required", async () => {
  const root = await createProject();
  for (const args of [
    ["run", "--project", "demo"],
    ["run", "--project", "demo", "--parent", "8", "--issue", "9"],
  ]) {
    const result = await executeCli(args, createCliDependencies(root));
    assert.equal(result.exitCode, 1);
    assert.match(result.summary.reasons[0] ?? "", /usage:/u);
  }
});

test("standalone issue runs without Documentation Maintenance configuration", async () => {
  const root = await createProject();
  const configPath = `${root}/projects/demo/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workflow: { documentationMaintenance: boolean };
    agents: Record<string, unknown>;
  };
  config.workflow.documentationMaintenance = true;
  delete config.agents.documentation;
  await writeFile(configPath, JSON.stringify(config));
  await rm(`${root}/projects/demo/prompts/documentation.md`);
  let parentReads = 0;
  let childReads = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentReads += 1;
          throw new Error("standalone mode must not read a parent");
        },
        async listChildrenPage() {
          childReads += 1;
          throw new Error("standalone mode must not list children");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.summary.issueTicket, 9);
  assert.equal(parentReads, 0);
  assert.equal(childReads, 0);
});

test("standalone issue applies ready-for-agent gating and terminal no_work", async () => {
  const root = await createProject();
  const writes: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return {
            number: 9,
            state: "open",
            stateReason: null,
            assignees: [],
            labels: [],
          };
        },
        async addLabel() {
          writes.push("label");
        },
        async addAssignee() {
          writes.push("assignee");
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(writes, []);

  const terminal = await executeCli(
    ["run", "--project", "demo", "--issue", "10"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return { number: 10, state: "closed", stateReason: "completed" };
        },
      },
    }),
  );
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.summary.outcome, "no_work");
});

test("standalone issue uses the selected issue as the Review specification", async () => {
  const root = await createProject();
  const configPath = `${root}/projects/demo/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workflow: { review: boolean; documentationMaintenance: boolean };
  };
  config.workflow.documentationMaintenance = false;
  config.workflow.review = true;
  await writeFile(configPath, JSON.stringify(config));
  const delivery = createCommittedDelivery(9);
  let governing = "";
  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        ...delivery.agentExecutor,
        async executeReview(input) {
          const handoff = JSON.parse(
            String(input.promptArgs.REVIEW_HANDOFF),
          ) as {
            governingSpecification?: { source?: unknown };
          };
          governing =
            typeof handoff.governingSpecification?.source === "string"
              ? handoff.governingSpecification.source
              : "";
          return {
            outcome: "passed",
            summary: "review passed",
            standards: { verdict: "passed", unresolved_findings: [] },
            spec: { verdict: "passed", unresolved_findings: [] },
            checks: [],
            blocker: null,
          };
        },
      },
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.batch, [9]);
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(governing, "https://github.com/owner/repo/issues/9");
});
