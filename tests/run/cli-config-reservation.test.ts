import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import {
  readRecoverySnapshot,
  recoveryPaths,
  writeRecoverySnapshot,
} from "../../src/recovery.ts";

test.afterEach(cleanupTempRoots);

test("disabled Documentation Maintenance allows delivery and Parent closeout without maintenance effects", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  delete config.agents.documentation;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...config,
      workflow: {
        $comment: "Review is disabled to isolate maintenance behavior.",
        review: false,
        documentationMaintenance: false,
      },
    }),
  );
  await rm(path.join(root, "projects/demo/prompts/documentation.md"));
  await writeRecoverySnapshot(
    recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
    {
      schemaVersion: 1,
      project: "demo",
      repository: "owner/repo",
      checkout: "/tmp/repo",
      parentTicket: 8,
      runId: "interrupted",
      phase: "blocked",
      targetBranch: "main",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      maintenance: { phase: "blocked", ticket: 100, credit: 1, barrier: true },
    },
  );
  const delivery = createCommittedDelivery(9);
  const attempts: number[] = [];
  let parentCloses = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async listLabelsPage() {
          throw new Error("maintenance labels must not be read");
        },
        async createLabel() {
          throw new Error("maintenance labels must not be created");
        },
        async createMaintenanceTicket() {
          throw new Error("Maintenance Tickets must not be created");
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        async execute(input) {
          attempts.push(input.ticket);
          return delivery.agentExecutor.execute!(input);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.deepEqual(attempts, [9]);
  assert.equal(parentCloses, 1);
  assert.equal(
    (
      await readRecoverySnapshot(
        recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
      )
    )?.maintenance,
    undefined,
  );
  assert.doesNotMatch(result.summary.reasons.join(" "), /maintenance/iu);
  assert.ok(result.logPath);
  assert.doesNotMatch(await readFile(result.logPath, "utf8"), /maintenance/iu);
});

test("Review and Documentation Maintenance switches operate independently and default on", async () => {
  const scenarios = [
    {
      workflow: { review: true, documentationMaintenance: false },
      reviews: 1,
      maintenance: 0,
    },
    {
      workflow: { review: false, documentationMaintenance: true },
      reviews: 0,
      maintenance: 1,
    },
    { workflow: undefined, reviews: 1, maintenance: 1 },
  ] as const;

  for (const scenario of scenarios) {
    const root = await createProject();
    const config: Omit<typeof validConfig, "workflow"> & {
      workflow?: typeof validConfig.workflow;
    } = structuredClone(validConfig);
    if (scenario.workflow === undefined) delete config.workflow;
    else config.workflow = scenario.workflow;
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify(config),
    );
    const delivery = createCommittedDelivery();
    let reviews = 0;
    let maintenance = 0;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...delivery.tracker,
          async listLabelsPage() {
            maintenance += 1;
            return { labels: ["doc-maintain"], nextPage: null };
          },
        },
        gitWorkspace: delivery.gitWorkspace,
        agentExecutor: {
          async execute(input) {
            return delivery.agentExecutor.execute!(input);
          },
          async executeReview() {
            reviews += 1;
            return {
              outcome: "passed",
              summary: "Both review axes pass.",
              standards: { verdict: "passed", unresolved_findings: [] },
              spec: { verdict: "passed", unresolved_findings: [] },
              checks: [],
              blocker: null,
            };
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(reviews, scenario.reviews);
    assert.equal(maintenance, scenario.maintenance);
  }
});

test("enabled Documentation Maintenance requires maintenance ticket title, body, and label", async () => {
  for (const field of ["title", "body", "label"] as const) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    delete config.maintenanceTicket[field];
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify(config),
    );
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root),
    );
    assert.equal(result.summary.outcome, "failed");
    assert.match(
      result.summary.reasons.join(" "),
      new RegExp(`maintenanceTicket\\.${field} must be set`),
    );
  }
});

test("workflow configuration rejects malformed switches, unknown fields, and invalid supplied disabled profiles", async () => {
  const cases = [
    {
      workflow: { review: "false", documentationMaintenance: false },
      expected: /workflow\.review must be a boolean/u,
    },
    {
      workflow: { documentationMaintenance: "false" },
      expected: /workflow\.documentationMaintenance must be a boolean/u,
    },
    {
      workflow: { documentationMaintenance: false, extra: true },
      expected: /workflow contains unknown field extra/u,
    },
    {
      workflow: { documentationMaintenance: false },
      documentation: { model: "unknown", reasoningEffort: "high" },
      expected: /agents\.documentation\.model is unsupported/u,
    },
  ];

  for (const scenario of cases) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    if (scenario.documentation) {
      config.agents.documentation = scenario.documentation;
    }
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify({ ...config, workflow: scenario.workflow }),
    );
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root),
    );

    assert.equal(result.summary.outcome, "failed");
    assert.match(result.summary.reasons[0] ?? "", scenario.expected);
    assert.equal(result.logPath, null);
  }
});

test("default-enabled Documentation Maintenance reports its required configuration and prompt paths", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      workflow: {
        $comment: "The maintenance switch is intentionally omitted.",
      },
    }),
  );
  await rm(path.join(root, "projects/demo/prompts/documentation.md"));

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Documentation Maintenance is enabled.*agents\.documentation.*prompts\/documentation\.md/u,
  );
  assert.equal(result.logPath, null);
});

test("enabled Documentation Maintenance rejects a missing profile", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  delete config.agents.documentation;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Documentation Maintenance is enabled.*agents\.documentation.*prompts\/documentation\.md/u,
  );
  assert.equal(result.logPath, null);
});

test("enabled Documentation Maintenance rejects an empty prompt", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/prompts/documentation.md"),
    " \n",
  );

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Documentation Maintenance is enabled.*agents\.documentation.*prompts\/documentation\.md/u,
  );
  assert.equal(result.logPath, null);
});

test("an accepted audit creation gap does not suppress later appends", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  await writeFile(logs, "blocks directory creation");
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      operator: {
        async pause() {
          pauseCalls += 1;
          await rm(logs);
          await mkdir(logs);
          return "accept this audit gap";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(pauseCalls, 1);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /read_parent/u);
});

test("invalid CLI arguments return a structured startup failure", async () => {
  let externalCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo"],
    createCliDependencies("/unused", {
      env: {},
      tracker: {
        async getParent() {
          externalCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          externalCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          externalCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          externalCalls += 1;
          return "main";
        },
      },
      operator: {
        async pause() {
          externalCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.summary.reasons[0] ?? "", /usage:/u);
  assert.equal(result.logPath, null);
  assert.equal(externalCalls, 0);
});

test("an omitted Target Branch is resolved once through CodeHost and fixed for the Run", async () => {
  const root = await createProject();
  const configPath = path.join(root, "projects", "demo", "config.json");
  const configWithoutBranch = { ...validConfig };
  delete (configWithoutBranch as Partial<typeof validConfig>).targetBranch;
  await writeFile(configPath, JSON.stringify(configWithoutBranch));
  let branchCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      codeHost: {
        async resolveTargetBranch() {
          branchCalls += 1;
          return "trunk";
        },
      },
    }),
  );

  assert.equal(result.summary.targetBranch, "trunk");
  assert.equal(branchCalls, 1);
});

test("a trusted Target Branch override uses the project term", async () => {
  const root = await createProject();
  const configPath = path.join(root, "projects", "demo", "config.json");
  const configWithoutBranch = { ...validConfig };
  delete (configWithoutBranch as Partial<typeof validConfig>).targetBranch;
  await writeFile(configPath, JSON.stringify(configWithoutBranch));
  let branchCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      codeHost: {
        async resolveTargetBranch() {
          branchCalls += 1;
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return pauseCalls === 1 ? '{"targetBranch":"trunk"}' : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "trunk");
  assert.equal(branchCalls, 5);
  assert.equal(pauseCalls, 1);
});

test("open children return an actionable incomplete summary", async () => {
  const root = await createProject();
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "open",
                stateReason: null,
                repository: "owner/repo",
                labels: ["sandcastle:reserved"],
              } as const,
            ],
            nextPage: null,
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.summary.reasons, [
    "existing Reservations: 9 (partial)",
  ]);
});

test("a Run reserves the three lowest-numbered eligible Delivery Tickets", async () => {
  const root = await createProject();
  const writes: string[] = [];
  const tickets = [12, 9, 11, 10].map((number) => ({
    number,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  }));

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: tickets, nextPage: null };
        },
        async getTicket(_repository, ticket) {
          return tickets.find(({ number }) => number === ticket)!;
        },
        async addLabel(_repository, ticket, label) {
          writes.push(`label:${ticket}:${label}`);
        },
        async addAssignee(_repository, ticket, assignee) {
          writes.push(`assignee:${ticket}:${assignee}`);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [9, 10, 11]);
  assert.deepEqual(writes, [
    "label:9:sandcastle:reserved",
    "assignee:9:runner",
    "label:10:sandcastle:reserved",
    "assignee:10:runner",
    "label:11:sandcastle:reserved",
    "assignee:11:runner",
  ]);
  assert.equal(result.summary.outcome, "incomplete");
});
