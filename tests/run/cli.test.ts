import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCli, type CliDependencies } from "../../src/cli.ts";
import type {
  Clock,
  CodeHost,
  OperatorIO,
  Tracker,
} from "../../src/run/contracts.ts";

type CliDependencyOverrides = Omit<
  Partial<CliDependencies>,
  "tracker" | "codeHost" | "clock" | "operator"
> & {
  tracker?: Partial<Tracker>;
  codeHost?: Partial<CodeHost>;
  clock?: Partial<Clock>;
  operator?: Partial<OperatorIO>;
};

function createCliDependencies(
  root: string,
  overrides: CliDependencyOverrides = {},
): CliDependencies {
  const tracker: Tracker = {
    async getParent() {
      return { number: 8, state: "open", stateReason: null };
    },
    async listChildrenPage() {
      return { children: [], nextPage: null };
    },
    async getTicket(_repository, ticket) {
      return { number: ticket, state: "open", stateReason: null };
    },
    async listBlockersPage() {
      return { blockers: [], nextPage: null };
    },
    async addLabel() {},
    async addAssignee() {},
    async removeLabel() {},
    async removeAssignee() {},
    async closeParent() {},
    ...overrides.tracker,
  };
  const codeHost: CodeHost = {
    async resolveTargetBranch() {
      return "ignored";
    },
    ...overrides.codeHost,
  };
  const clock: Clock = {
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    async sleep() {},
    ...overrides.clock,
  };
  const operator: OperatorIO = {
    write() {},
    async pause() {
      throw new Error("no Operator Pause expected");
    },
    ...overrides.operator,
  };

  return {
    root,
    env: { TEST_GH_TOKEN: "secret" },
    ...overrides,
    tracker,
    codeHost,
    clock,
    operator,
  };
}

const validConfig = {
  repository: "owner/repo",
  checkout: "/tmp/repo",
  targetBranch: "main",
  tracker: {
    type: "github",
    tokenEnv: "TEST_GH_TOKEN",
    runnerAccount: "runner",
    reservationLabel: "sandcastle:reserved",
  },
  codeHost: {
    type: "github",
    tokenEnv: "TEST_GH_TOKEN",
    adminMerge: false,
  },
  agents: Object.fromEntries(
    ["implement", "ciRepair", "conflictRepair", "documentation"].map((name) => [
      name,
      { model: "gpt-5.6-sol", reasoningEffort: "high" },
    ]),
  ),
  timeouts: {
    agentMinutes: 120,
    requiredChecksMinutes: 60,
    mergeQueueMinutes: 60,
  },
  ticketClosure: "runner",
};

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-runner-"));
  projectRoots.add(root);
  const project = path.join(root, "projects", "demo");
  await mkdir(path.join(project, "prompts"), { recursive: true });
  await writeFile(
    path.join(project, "config.json"),
    JSON.stringify(validConfig),
  );
  await Promise.all(
    ["implement", "ci-repair", "conflict-repair", "documentation"].map((name) =>
      writeFile(path.join(project, "prompts", `${name}.md`), `${name} prompt`),
    ),
  );
  return root;
}

const projectRoots = new Set<string>();

test.afterEach(async () => {
  await Promise.all(
    [...projectRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  projectRoots.clear();
});

test("a complete zero-child scan returns no_work and leaves the Parent open", async () => {
  const root = await createProject();
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async closeParent() {
          closeCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          throw new Error("explicit Target Branch must not be replaced");
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "main");
  assert.equal(closeCalls, 0);

  assert.ok(result.logPath);
  const events = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(events.length > 0);
  assert.deepEqual(Object.keys(events[0] ?? {}).sort(), [
    "attempt",
    "error",
    "operation",
    "parentTicket",
    "phase",
    "project",
    "result",
    "runId",
    "target",
    "timestamp",
  ]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("an all-cancelled paginated scan closes the Parent as completed", async () => {
  const root = await createProject();
  const pages: number[] = [];
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage(_repository, _parent, page) {
          pages.push(page);
          return page === 1
            ? {
                children: [
                  {
                    number: 9,
                    state: "closed",
                    stateReason: "not_planned",
                    repository: "owner/repo",
                  } as const,
                ],
                nextPage: 2,
              }
            : {
                children: [
                  {
                    number: 10,
                    state: "closed",
                    stateReason: "not_planned",
                    repository: "owner/repo",
                  } as const,
                ],
                nextPage: null,
              };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(closeCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
});

test("a cancelled Parent stops without reading or modifying children", async () => {
  const root = await createProject();
  let childCalls = 0;
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return {
            number: 8,
            state: "closed",
            stateReason: "not_planned",
          } as const;
        },
        async listChildrenPage() {
          childCalls += 1;
          return { children: [], nextPage: null };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.exitCode, 1);
  assert.equal(childCalls, 0);
  assert.equal(closeCalls, 0);
});

test("a cross-repository child fails explicitly without Operator Pause", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "another/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /cross-repository/u);
  assert.equal(result.exitCode, 1);
  assert.equal(closeCalls, 0);
  assert.equal(pauseCalls, 0);
});

test("a completed Parent with an open child fails as contradictory", async () => {
  const root = await createProject();
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return {
            number: 8,
            state: "closed",
            stateReason: "completed",
          } as const;
        },
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "open",
                stateReason: null,
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /completed Parent Ticket has open children/u,
  );
  assert.equal(closeCalls, 0);
});

test("a closed Parent without a supported reason fails before child discovery", async () => {
  const root = await createProject();
  let childCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return { number: 8, state: "closed", stateReason: null } as const;
        },
        async listChildrenPage() {
          childCalls += 1;
          return { children: [], nextPage: null };
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /closed Parent Ticket/u);
  assert.equal(childCalls, 0);
  assert.equal(pauseCalls, 0);
});

test("an external read succeeds on the fifth call with fixed delays", async () => {
  const root = await createProject();
  let parentCalls = 0;
  const sleeps: number[] = [];
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          if (parentCalls < 5) throw new Error("temporary read failure");
          return { number: 8, state: "open", stateReason: null } as const;
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 5);
  assert.deepEqual(sleeps, [5000, 5000, 5000, 5000]);
  assert.equal(pauseCalls, 0);
});

test("q and EOF at an exhausted external read cancel the Run", async () => {
  for (const response of ["q", null] as const) {
    const root = await createProject();
    let parentCalls = 0;
    let pauseCalls = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          async getParent() {
            parentCalls += 1;
            throw new Error("unavailable");
          },
          async listChildrenPage() {
            throw new Error("must not scan children");
          },
        },
        operator: {
          async pause() {
            pauseCalls += 1;
            return response;
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(result.exitCode, 1);
    assert.equal(parentCalls, 5);
    assert.equal(pauseCalls, 1);
    assert.ok(result.logPath);
    const pauseResults = (await readFile(result.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.operation === "operator_pause")
      .map((event) => event.result);
    assert.deepEqual(pauseResults, ["started", "cancelled"]);
  }
});

test("an unusable read override pauses again and never enters the audit log", async () => {
  const root = await createProject();
  let parentCalls = 0;
  const responses = ["{}", '{"state":"open"}'];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.ok(result.logPath);
  const log = await readFile(result.logPath, "utf8");
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 5);
  assert.equal(responses.length, 0);
  assert.equal(log.includes('"operator_override":"{}"'), false);
  assert.equal(log.includes("operator_override"), true);
});

test("a child read override without repository pauses again", async () => {
  const root = await createProject();
  let childCalls = 0;
  const responses = [
    '{"children":[{"number":9,"state":"closed","stateReason":"completed"}],"nextPage":null}',
    '{"children":[{"number":9,"state":"closed","stateReason":"completed","repository":"owner/repo"}],"nextPage":null}',
  ];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childCalls += 1;
          if (childCalls > 5) {
            return {
              children: [
                {
                  number: 9,
                  state: "closed",
                  stateReason: "completed",
                  repository: "owner/repo",
                },
              ],
              nextPage: null,
            };
          }
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(childCalls, 6);
  assert.equal(responses.length, 0);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /invalid_override/u);
});

test("empty Operator Pause input resets the complete read budget", async () => {
  const root = await createProject();
  let parentCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          if (parentCalls <= 5) throw new Error("unavailable");
          return { number: 8, state: "open", stateReason: null } as const;
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 6);
  assert.equal(pauseCalls, 1);
});

test("a failed Parent close pauses immediately and retries only after empty input", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("write failed");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 2);
  assert.equal(pauseCalls, 1);
});

test("a nonempty write override continues without replay or reconciliation", async () => {
  const root = await createProject();
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
          throw new Error("response lost");
        },
      },
      operator: {
        async pause() {
          return "I confirmed the write";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 1);
  assert.ok(result.logPath);
  assert.equal(
    (await readFile(result.logPath, "utf8")).includes("I confirmed"),
    false,
  );
});

test("startup validation errors return a failed summary without workflow or pause", async () => {
  const root = await createProject();
  let workflowCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      env: {},
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          workflowCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.summary.reasons[0] ?? "", /missing credential/u);
  assert.equal(result.logPath, null);
  assert.equal(workflowCalls, 0);
  assert.equal(pauseCalls, 0);
});

test("an empty required prompt fails startup before workflow operations", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects", "demo", "prompts", "implement.md"),
    "",
  );
  let workflowCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          workflowCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          workflowCalls += 1;
          return "main";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /implement.md.*empty/u);
  assert.equal(workflowCalls, 0);
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

test("eligibility reports ownership and Reservations after complete blocker pagination", async () => {
  const root = await createProject();
  const writes: number[] = [];
  const children = [
    { number: 9, assignees: ["developer"], labels: [] },
    { number: 10, assignees: [], labels: ["sandcastle:reserved"] },
    { number: 11, assignees: ["runner"], labels: [] },
    {
      number: 12,
      assignees: ["runner"],
      labels: ["sandcastle:reserved"],
    },
    { number: 13, assignees: [], labels: [] },
    { number: 14, assignees: [], labels: [] },
  ].map((ticket) => ({
    ...ticket,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
  }));
  const blockerPages: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children, nextPage: null };
        },
        async listBlockersPage(_repository, ticket, page) {
          blockerPages.push(`${ticket}:${page}`);
          if (ticket === 13) {
            return page === 1
              ? {
                  blockers: [
                    {
                      number: 30,
                      state: "closed",
                      stateReason: "completed",
                      repository: "outside/repo",
                    },
                  ],
                  nextPage: 2,
                }
              : {
                  blockers: [
                    {
                      number: 31,
                      state: "open",
                      stateReason: null,
                      repository: "outside/repo",
                    },
                  ],
                  nextPage: null,
                };
          }
          if (ticket === 14) {
            return page === 1
              ? {
                  blockers: [
                    {
                      number: 32,
                      state: "closed",
                      stateReason: "completed",
                    },
                  ],
                  nextPage: 2,
                }
              : {
                  blockers: [
                    {
                      number: 33,
                      state: "closed",
                      stateReason: "not_planned",
                    },
                  ],
                  nextPage: null,
                };
          }
          return { blockers: [], nextPage: null };
        },
        async addLabel(_repository, ticket) {
          writes.push(ticket);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [14]);
  assert.deepEqual(writes, [14]);
  assert.deepEqual(blockerPages, [
    "9:1",
    "10:1",
    "11:1",
    "12:1",
    "13:1",
    "13:2",
    "14:1",
    "14:2",
    "14:1",
    "14:2",
    "14:1",
    "14:2",
    "14:1",
    "14:2",
  ]);
  assert.deepEqual(result.summary.reasons, [
    "reserved Delivery Tickets: 14",
    "blocked Delivery Tickets: 13",
    "externally owned Delivery Tickets: 9",
    "existing Reservations: 10 (partial), 11 (partial), 12 (complete)",
  ]);
});

test("Parent cancellation before Reservation stops without mutating children", async () => {
  const root = await createProject();
  let parentReads = 0;
  let childWrites = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentReads += 1;
          return parentReads === 1
            ? { number: 8, state: "open", stateReason: null }
            : {
                number: 8,
                state: "closed",
                stateReason: "not_planned",
              };
        },
        async listChildrenPage() {
          return { children: [child], nextPage: null };
        },
        async getTicket() {
          return child;
        },
        async addLabel() {
          childWrites += 1;
        },
        async addAssignee() {
          childWrites += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(parentReads, 2);
  assert.equal(childWrites, 0);
});

test("a terminal Delivery Ticket releases a partial Reservation before the next marker", async () => {
  const root = await createProject();
  const writes: string[] = [];
  let ticketReads = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: [child], nextPage: null };
        },
        async getTicket() {
          ticketReads += 1;
          return ticketReads === 1
            ? child
            : {
                ...child,
                state: "closed",
                stateReason: "completed",
                labels: ["sandcastle:reserved"],
              };
        },
        async addLabel() {
          writes.push("add label");
        },
        async addAssignee() {
          writes.push("add assignee");
        },
        async removeLabel() {
          writes.push("remove label");
        },
        async removeAssignee() {
          writes.push("remove assignee");
        },
      },
    }),
  );

  assert.deepEqual(writes, ["add label", "remove label"]);
});

test("a Delivery Ticket removed from Parent scope is not reserved", async () => {
  const root = await createProject();
  let childScans = 0;
  let childWrites = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: childScans === 1 ? [child] : [],
            nextPage: null,
          };
        },
        async getTicket() {
          return child;
        },
        async addLabel() {
          childWrites += 1;
        },
        async addAssignee() {
          childWrites += 1;
        },
      },
    }),
  );

  assert.equal(childScans, 3);
  assert.equal(childWrites, 0);
});

test("a terminal Delivery Ticket releases a complete Reservation before the checkpoint", async () => {
  const root = await createProject();
  const writes: string[] = [];
  let ticketReads = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: [child], nextPage: null };
        },
        async getTicket() {
          ticketReads += 1;
          return ticketReads < 3
            ? child
            : {
                ...child,
                state: "closed",
                stateReason: "not_planned",
                assignees: ["runner"],
                labels: ["sandcastle:reserved"],
              };
        },
        async addLabel() {
          writes.push("add label");
        },
        async addAssignee() {
          writes.push("add assignee");
        },
        async removeAssignee() {
          writes.push("remove assignee");
        },
        async removeLabel() {
          writes.push("remove label");
        },
      },
    }),
  );

  assert.deepEqual(writes, [
    "add label",
    "add assignee",
    "remove assignee",
    "remove label",
  ]);
  assert.deepEqual(result.summary.batch, []);
});

test("the final complete scan reserves newly eligible work", async () => {
  const root = await createProject();
  let childScans = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              childScans === 1
                ? { ...child, labels: ["sandcastle:reserved"] }
                : child,
            ],
            nextPage: null,
          };
        },
        async getTicket() {
          return child;
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [9]);
  assert.ok(childScans > 1);
});

test("new work in the final closeout scan prevents Parent closure", async () => {
  const root = await createProject();
  let childScans = 0;
  let closeCalls = 0;
  const child = {
    number: 9,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              childScans === 1
                ? {
                    ...child,
                    state: "closed" as const,
                    stateReason: "completed" as const,
                  }
                : {
                    ...child,
                    state: "open" as const,
                    stateReason: null,
                  },
            ],
            nextPage: null,
          };
        },
        async getTicket() {
          return { ...child, state: "open", stateReason: null };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [9]);
  assert.equal(closeCalls, 0);
});

test("an incomplete blocker read never produces Parent closeout", async () => {
  const root = await createProject();
  let blockerReads = 0;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              },
            ],
            nextPage: null,
          };
        },
        async listBlockersPage() {
          blockerReads += 1;
          throw new Error("incomplete dependency page");
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(blockerReads, 5);
  assert.equal(closeCalls, 0);
});

test("a failed second Reservation marker keeps the partial write", async () => {
  const root = await createProject();
  const writes: string[] = [];
  let assigneeCalls = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: [child], nextPage: null };
        },
        async getTicket() {
          return child;
        },
        async addLabel() {
          writes.push("add label");
        },
        async addAssignee() {
          assigneeCalls += 1;
          throw new Error("assignee write failed");
        },
        async removeLabel() {
          writes.push("remove label");
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(assigneeCalls, 1);
  assert.deepEqual(writes, ["add label"]);
});

test("a cross-repository child with the selected number fails revalidation", async () => {
  const root = await createProject();
  let childScans = 0;
  let childWrites = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              {
                ...child,
                repository: childScans === 1 ? "owner/repo" : "another/repo",
              },
            ],
            nextPage: null,
          };
        },
        async getTicket() {
          return { ...child, repository: "owner/repo" };
        },
        async addLabel() {
          childWrites += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /cross-repository/u);
  assert.equal(childWrites, 0);
});

test("revalidation discovers another eligible Delivery Ticket before exhaustion", async () => {
  const root = await createProject();
  let childScans = 0;
  const ticket = (number: number, assignees: string[] = []) => ({
    number,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees,
    labels: [],
  });

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children:
              childScans === 1
                ? [ticket(9)]
                : [ticket(9, ["developer"]), ticket(10)],
            nextPage: null,
          };
        },
        async getTicket(_repository, number) {
          return number === 9 ? ticket(9, ["developer"]) : ticket(10);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [10]);
});

test("the final complete scan closes a now-terminal Parent scope", async () => {
  const root = await createProject();
  let childScans = 0;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              {
                number: 9,
                state: childScans === 1 ? "open" : "closed",
                stateReason: childScans === 1 ? null : "completed",
                repository: "owner/repo",
                assignees: [],
                labels: childScans === 1 ? ["sandcastle:reserved"] : [],
              },
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 1);
});

test("cancelling a failed audit result append pauses exactly once", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          const [filename] = await readdir(logs);
          assert.ok(filename);
          const logPath = path.join(logs, filename);
          await rm(logPath);
          await mkdir(logPath);
          return { number: 8, state: "open", stateReason: null } as const;
        },
        async listChildrenPage() {
          throw new Error("must not scan children");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauseCalls, 1);
});

test("unsupported model and effort selections fail before workflow operations", async () => {
  for (const implement of [
    { model: "gpt-not-real", reasoningEffort: "high" },
    { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
  ]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.agents = { ...config.agents, implement };
    await writeFile(
      path.join(root, "projects", "demo", "config.json"),
      JSON.stringify(config),
    );
    let workflowCalls = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          async getParent() {
            workflowCalls += 1;
            throw new Error("must not run");
          },
          async listChildrenPage() {
            workflowCalls += 1;
            throw new Error("must not run");
          },
          async closeParent() {
            workflowCalls += 1;
          },
        },
        codeHost: {
          async resolveTargetBranch() {
            workflowCalls += 1;
            return "main";
          },
        },
        operator: {
          async pause() {
            workflowCalls += 1;
            return "q";
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "failed");
    assert.match(result.summary.reasons[0] ?? "", /unsupported/u);
    assert.equal(workflowCalls, 0);
  }
});

test("empty input retries a failed audit creation", async () => {
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
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(pauseCalls, 1);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /read_parent/u);
});

test("a fresh Run ignores existing audit logs", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  await mkdir(logs);
  const oldLog = path.join(logs, "earlier.jsonl");
  await writeFile(oldLog, "not valid JSON and not recovery state\n");
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.ok(result.logPath);
  assert.notEqual(result.logPath, oldLog);
  assert.equal(
    await readFile(oldLog, "utf8"),
    "not valid JSON and not recovery state\n",
  );
});

test("a contradictory Parent read override fails without a second pause", async () => {
  const root = await createProject();
  let parentCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return pauseCalls === 1
            ? '{"state":"closed","stateReason":null}'
            : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /closed Parent Ticket/u);
  assert.equal(parentCalls, 5);
  assert.equal(pauseCalls, 1);
});
