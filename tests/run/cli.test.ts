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

  assert.deepEqual(pages, [1, 2]);
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
  assert.equal(childCalls, 5);
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
  assert.deepEqual(result.summary.reasons, ["open Delivery Tickets: 9"]);
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
