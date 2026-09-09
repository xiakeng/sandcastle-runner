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
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  RequiredCheck,
  Tracker,
} from "../../src/run/contracts.ts";

type CliDependencyOverrides = Omit<
  Partial<CliDependencies>,
  | "tracker"
  | "codeHost"
  | "gitWorkspace"
  | "agentExecutor"
  | "clock"
  | "operator"
> & {
  tracker?: Partial<Tracker>;
  codeHost?: Partial<CodeHost>;
  gitWorkspace?: Partial<GitWorkspace>;
  agentExecutor?: Partial<AgentExecutor>;
  clock?: Partial<Clock>;
  operator?: Partial<OperatorIO>;
};

function createCliDependencies(
  root: string,
  overrides: CliDependencyOverrides = {},
): CliDependencies {
  const completedTickets = new Set<number>();
  const tracker: Tracker = {
    async getParent() {
      return { number: 8, state: "open", stateReason: null };
    },
    async listChildrenPage() {
      return { children: [], nextPage: null };
    },
    async getTicket(_repository, ticket) {
      return completedTickets.has(ticket)
        ? { number: ticket, state: "closed", stateReason: "completed" }
        : { number: ticket, state: "open", stateReason: null };
    },
    async listBlockersPage() {
      return { blockers: [], nextPage: null };
    },
    async addLabel() {},
    async addAssignee() {},
    async removeLabel() {},
    async removeAssignee() {},
    async closeTicket(_repository, ticket) {
      completedTickets.add(ticket);
    },
    async closeParent() {},
    ...overrides.tracker,
  };
  let merged = false;
  const codeHost: CodeHost = {
    async resolveTargetBranch() {
      return "ignored";
    },
    async createPullRequest() {
      return { number: 1, url: "https://github.com/owner/repo/pull/1" };
    },
    async getRequiredChecks() {
      return [];
    },
    async getPullRequest() {
      return {
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        merged,
        mergeFailure: null,
      };
    },
    async requestSquashMerge() {
      merged = true;
      return { outcome: "accepted" };
    },
    ...overrides.codeHost,
  };
  const gitWorkspace: GitWorkspace = {
    async fetchTargetBranch() {
      return "base";
    },
    async createWorktree() {},
    async inspect({ worktree, base }) {
      return {
        worktree,
        branch: "unused",
        base,
        commits: [],
        clean: true,
      };
    },
    async push() {},
    ...overrides.gitWorkspace,
  };
  const agentExecutor: AgentExecutor = {
    async execute() {
      return {
        outcome: "blocked",
        summary: "not enabled for this scenario",
        commits: [],
        checks: [],
        blocker: "not enabled for this scenario",
        pr_title: "unused",
        pr_body: "unused",
      };
    },
    ...overrides.agentExecutor,
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
    gitWorkspace,
    agentExecutor,
    clock,
    operator,
  };
}

function createAttemptTracker(...numbers: number[]): {
  tickets: {
    number: number;
    state: "open" | "closed";
    stateReason: null | "completed" | "not_planned";
    repository: string;
    assignees: string[];
    labels: string[];
  }[];
  tracker: Partial<Tracker>;
} {
  const tickets: {
    number: number;
    state: "open" | "closed";
    stateReason: null | "completed" | "not_planned";
    repository: string;
    assignees: string[];
    labels: string[];
  }[] = numbers.map((number) => ({
    number,
    state: "open",
    stateReason: null,
    repository: "owner/repo",
    assignees: [] as string[],
    labels: [] as string[],
  }));
  return {
    tickets,
    tracker: {
      async listChildrenPage() {
        return { children: tickets, nextPage: null };
      },
      async getTicket(_repository, ticket) {
        return tickets.find(({ number }) => number === ticket)!;
      },
      async addLabel(_repository, ticket, label) {
        tickets.find(({ number }) => number === ticket)!.labels.push(label);
      },
      async addAssignee(_repository, ticket, assignee) {
        tickets
          .find(({ number }) => number === ticket)!
          .assignees.push(assignee);
      },
      async removeLabel(_repository, ticket, label) {
        const found = tickets.find(({ number }) => number === ticket)!;
        found.labels = found.labels.filter((value) => value !== label);
      },
      async removeAssignee(_repository, ticket, assignee) {
        const found = tickets.find(({ number }) => number === ticket)!;
        found.assignees = found.assignees.filter((value) => value !== assignee);
      },
      async closeTicket(_repository, ticket) {
        const found = tickets.find(({ number }) => number === ticket)!;
        found.state = "closed";
        found.stateReason = "completed";
      },
    },
  };
}

function createCommittedDelivery(ticket = 9): {
  tracker: Partial<Tracker>;
  tickets: ReturnType<typeof createAttemptTracker>["tickets"];
  gitWorkspace: Partial<GitWorkspace>;
  agentExecutor: Partial<AgentExecutor>;
} {
  const { tracker, tickets } = createAttemptTracker(ticket);
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  let branch = "";
  return {
    tracker,
    tickets,
    gitWorkspace: {
      async fetchTargetBranch() {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async createWorktree(input) {
        branch = input.branch;
      },
      async inspect({ worktree, base }) {
        return { worktree, branch, base, commits: [commit], clean: true };
      },
    },
    agentExecutor: {
      async execute() {
        return {
          outcome: "committed",
          summary: "implemented",
          commits: [commit],
          checks: [],
          blocker: null,
          pr_title: "feat: implementation",
          pr_body: "Implementation body.",
        };
      },
    },
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
    "14:1",
    "14:2",
  ]);
  assert.deepEqual(result.summary.reasons, [
    "reserved Delivery Tickets: 14",
    "blocked Delivery Tickets: 13",
    "externally owned Delivery Tickets: 9",
    "existing Reservations: 10 (partial), 11 (partial), 12 (complete)",
    "Delivery Ticket 14 no longer has a complete Reservation",
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

test("successive revalidation changes cannot hide newly eligible work", async () => {
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
          const children =
            childScans === 1
              ? [ticket(9)]
              : childScans < 4
                ? [ticket(9, ["developer"]), ticket(10)]
                : [
                    ticket(9, ["developer"]),
                    ticket(10, ["developer"]),
                    ticket(11),
                  ];
          return { children, nextPage: null };
        },
        async getTicket(_repository, number) {
          return number === 11 ? ticket(11) : ticket(number, ["developer"]);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [11]);
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

test("a Verified Handoff is published unchanged and becomes CI-ready after check discovery", async () => {
  const root = await createProject();
  const operations: string[] = [];
  let prepared: { worktree: string; branch: string; base: string } | undefined;
  let agentInput: Parameters<AgentExecutor["execute"]>[0] | undefined;
  let gitConfigContents: string | undefined;
  let checkReads = 0;
  const { tracker } = createAttemptTracker(9);

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch(checkout, targetBranch) {
          operations.push(`fetch:${checkout}:${targetBranch}`);
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          prepared = input;
          operations.push(`create:${input.branch}:${input.base}`);
        },
        async inspect({ worktree, base }) {
          operations.push(`inspect:${base}`);
          assert.ok(prepared);
          return {
            worktree,
            branch: prepared.branch,
            base,
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: implement ticket",
              },
            ],
            clean: true,
          };
        },
        async push(worktree, branch) {
          operations.push(`push:${worktree}:${branch}`);
        },
      },
      codeHost: {
        async createPullRequest(input) {
          operations.push(
            `pr:${input.repository}:${input.targetBranch}:${input.branch}:${input.title}:${input.body}`,
          );
          return {
            number: 41,
            url: "https://github.com/owner/repo/pull/41",
          };
        },
        async getRequiredChecks(repository, pullRequest) {
          operations.push(`checks:${repository}:${pullRequest}`);
          checkReads += 1;
          if (checkReads === 1) throw new Error("temporary read failure");
          return [];
        },
      },
      clock: {
        async sleep(milliseconds) {
          operations.push(`sleep:${milliseconds}`);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentInput = input;
          gitConfigContents = await readFile(input.gitConfigGlobal, "utf8");
          operations.push(
            `execute:${input.ticket}:${input.branch}:${input.base}`,
          );
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: implement ticket",
              },
            ],
            checks: [{ command: "npm test", status: "passed", details: "ok" }],
            blocker: null,
            pr_title: "feat: implement ticket",
            pr_body: "Implements the Delivery Ticket.",
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.ok(prepared);
  assert.deepEqual(result.summary.handoffs, [
    {
      ticket: 9,
      worktree: prepared.worktree,
      branch: prepared.branch,
      base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commits: [
        {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          message: "feat: implement ticket",
        },
      ],
      checks: [{ command: "npm test", status: "passed", details: "ok" }],
      prTitle: "feat: implement ticket",
      prBody: "Implements the Delivery Ticket.",
      verification: "verified",
    },
  ]);
  assert.deepEqual(result.summary.pullRequests, [
    {
      ticket: 9,
      branch: prepared.branch,
      number: 41,
      url: "https://github.com/owner/repo/pull/41",
      readiness: "ready",
      failedChecks: [],
    },
  ]);
  assert.match(prepared.branch, /^sandcastle\/run-[0-9a-f-]+\/ticket-9$/u);
  assert.equal(path.isAbsolute(prepared.worktree), true);
  assert.ok(agentInput);
  assert.equal(
    agentInput.promptFile,
    path.join(root, "projects/demo/prompts/implement.md"),
  );
  assert.deepEqual(agentInput.promptArgs, {
    TICKET_NUMBER: 9,
    TICKET_REFERENCE: "owner/repo#9",
    IMPLEMENT_SKILL: "$implement",
    WORKTREE_PATH: prepared.worktree,
    BRANCH: prepared.branch,
    BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TARGET_BRANCH: "main",
  });
  assert.equal(agentInput.model, "gpt-5.6-sol");
  assert.equal(agentInput.effort, "high");
  assert.equal(agentInput.timeoutMs, 120 * 60_000);
  assert.equal(gitConfigContents, "");
  await assert.rejects(readFile(agentInput.gitConfigGlobal, "utf8"));
  assert.deepEqual(operations, [
    "fetch:/tmp/repo:main",
    `create:${prepared.branch}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    `execute:9:${prepared.branch}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    "inspect:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    `push:${prepared.worktree}:${prepared.branch}`,
    `pr:owner/repo:main:${prepared.branch}:feat: implement ticket:Implements the Delivery Ticket.`,
    "sleep:30000",
    "checks:owner/repo:41",
    "sleep:5000",
    "checks:owner/repo:41",
  ]);
});

test("a CI-ready Pull Request is delivered only after its merge and completed closure are confirmed", async () => {
  const root = await createProject();
  const operations: string[] = [];
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tickets, tracker } = createAttemptTracker(9);
  let branch = "";
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async closeTicket(_repository: string, ticket: number) {
          operations.push(`close:${ticket}`);
          const found = tickets.find(({ number }) => number === ticket)!;
          found.state = "closed";
          found.stateReason = "completed";
        },
        async removeAssignee(_repository, ticket) {
          operations.push(`unassign:${ticket}`);
        },
        async removeLabel(_repository, ticket) {
          operations.push(`unlabel:${ticket}`);
        },
      } as Partial<Tracker>,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [commit], clean: true };
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async getPullRequest() {
          operations.push(`observe:${merged}`);
          return {
            headSha: commit.sha,
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge(input: {
          pullRequest: number;
          headSha: string;
          admin: boolean;
        }) {
          operations.push(
            `merge:${input.pullRequest}:${input.headSha}:${input.admin}`,
          );
          merged = true;
          return { outcome: "accepted" as const };
        },
      } as Partial<CodeHost>,
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.deepEqual(operations, [
    "observe:false",
    `merge:1:${commit.sha}:false`,
    "observe:true",
    "close:9",
    "unassign:9",
    "unlabel:9",
  ]);
});

test("code_host closure waits 10 seconds and then another 30 seconds while leaving closure to GitHub", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  const sleeps: number[] = [];
  let waitedTen = false;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket() {
          closeCalls += 1;
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
          if (milliseconds === 10_000) waitedTen = true;
          if (milliseconds === 30_000 && waitedTen) {
            delivery.tickets[0]!.state = "closed";
            delivery.tickets[0]!.stateReason = "completed";
          }
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(closeCalls, 0);
  assert.deepEqual(sleeps, [30_000, 10_000, 30_000]);
});

test("a queued merge receives no completion credit until timeout recovery confirms success", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 1 / 60_000 },
    }),
  );
  const delivery = createCommittedDelivery();
  let elapsed = 0;
  let mergeRequests = 0;
  let closeCalls = 0;
  const responses = ["", "trusted merge"];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket(_repository, ticket) {
          closeCalls += 1;
          const found = delivery.tickets.find(
            ({ number }) => number === ticket,
          )!;
          found.state = "closed";
          found.stateReason = "completed";
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Merge confirmation timed out/u);
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(mergeRequests, 1);
  assert.equal(closeCalls, 1);
});

test("merge conflict evidence is retained while other merge rejections enter Operator Pause", async () => {
  for (const scenario of [
    {
      outcome: "conflict" as const,
      error: "GitHub reported a merge conflict in src/run.ts",
      expectedOutcome: "incomplete",
      pauses: 0,
    },
    {
      outcome: "rejected" as const,
      error: "GitHub rejected admin bypass",
      expectedOutcome: "cancelled",
      pauses: 1,
    },
  ]) {
    const root = await createProject();
    const delivery = createCommittedDelivery();
    let pauses = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        codeHost: {
          async getPullRequest() {
            return {
              headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              merged: false,
              mergeFailure: null,
            };
          },
          async requestSquashMerge() {
            return { outcome: scenario.outcome, error: scenario.error };
          },
        },
        operator: {
          async pause() {
            pauses += 1;
            return "q";
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, scenario.expectedOutcome);
    assert.deepEqual(result.summary.completedTickets ?? [], []);
    assert.equal(pauses, scenario.pauses);
    assert.ok(result.logPath);
    const evidence = `${result.summary.reasons.join(" ")} ${await readFile(result.logPath, "utf8")}`;
    assert.match(evidence, new RegExp(scenario.error));
  }
});

test("Parent cancellation during a merge rejection pause prevents the authorized retry", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let parentCancelled = false;
  let mergeRequests = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return parentCancelled
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "rejected", error: "merge rejected" };
        },
      },
      operator: {
        async pause() {
          parentCancelled = true;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(mergeRequests, 1);
});

test("a post-merge cancellation releases its Reservation without completion credit", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  let releases = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async removeAssignee() {
          releases += 1;
        },
        async removeLabel() {
          releases += 1;
        },
      },
      clock: {
        async sleep(milliseconds) {
          if (milliseconds === 10_000) {
            delivery.tickets[0]!.state = "closed";
            delivery.tickets[0]!.stateReason = "not_planned";
          }
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.equal(releases, 2);
  assert.match(result.summary.reasons.join(" "), /cancelled after merge/u);
});

test("runner closure write failure retries only after operator authorization and never replays the merge", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let closeCalls = 0;
  let mergeCalls = 0;
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket(_repository, ticket) {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("closure write failed");
          const found = delivery.tickets.find(
            ({ number }) => number === ticket,
          )!;
          found.state = "closed";
          found.stateReason = "completed";
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeCalls += 1;
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(closeCalls, 2);
  assert.equal(mergeCalls, 1);
});

test("confirmed completion credit survives a later Reservation release cancellation", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async removeAssignee() {
          throw new Error("release failed");
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
  assert.deepEqual(result.summary.completedTickets, [9]);
});

test("Parent cancellation during a closure write pause prevents the authorized retry", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let closeCalls = 0;
  let parentCancelled = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return parentCancelled
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async closeTicket() {
          closeCalls += 1;
          throw new Error("closure write failed");
        },
      },
      operator: {
        async pause() {
          parentCancelled = true;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 1);
});

test("an open code_host ticket after both closure reads enters Operator Pause without credit", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  let pauseMessage = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      operator: {
        async pause(message) {
          pauseMessage = message;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.match(pauseMessage, /not closed as completed/u);
});

test("trusted completion releases the observed Reservation unless the Parent was cancelled", async () => {
  for (const cancelParent of [false, true]) {
    const root = await createProject();
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
    );
    const delivery = createCommittedDelivery();
    let parentCancelled = false;
    let releases = 0;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        tracker: {
          ...delivery.tracker,
          async getParent() {
            return parentCancelled
              ? { number: 8, state: "closed", stateReason: "not_planned" }
              : { number: 8, state: "open", stateReason: null };
          },
          async removeAssignee() {
            releases += 1;
          },
          async removeLabel() {
            releases += 1;
          },
        },
        operator: {
          async pause() {
            parentCancelled = cancelParent;
            return "trusted completion";
          },
        },
      }),
    );

    assert.deepEqual(
      result.summary.completedTickets ?? [],
      cancelParent ? [] : [9],
    );
    assert.equal(releases, cancelParent ? 0 : 2);
  }
});

test("Parent cancellation after merge confirmation prevents ticket closure mutations", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let merged = false;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return merged
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async closeTicket() {
          closeCalls += 1;
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          merged = true;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 0);
});

test("required-check polling preserves terminal failure and cancellation evidence", async () => {
  const scenarios: {
    name: string;
    reads: RequiredCheck[][];
    readiness: "ready" | "failed";
    failedChecks: RequiredCheck[];
    sleeps: number[];
  }[] = [
    {
      name: "pending then passing",
      reads: [
        [
          {
            name: "build",
            state: "IN_PROGRESS",
            link: "https://github.com/owner/repo/actions/runs/1",
            bucket: "pending",
          },
        ],
        [
          {
            name: "build",
            state: "SUCCESS",
            link: "https://github.com/owner/repo/actions/runs/1",
            bucket: "pass",
          },
        ],
      ],
      readiness: "ready",
      failedChecks: [],
      sleeps: [30_000, 10_000],
    },
    ...(["fail", "cancel"] as const).map((bucket) => {
      const check = {
        name: bucket === "fail" ? "build" : "deploy",
        state: bucket === "fail" ? "FAILURE" : "CANCELLED",
        link: `https://github.com/owner/repo/actions/runs/${bucket}`,
        bucket,
      };
      return {
        name: bucket,
        reads: [[check]],
        readiness: "failed" as const,
        failedChecks: [check],
        sleeps: [30_000],
      };
    }),
  ];

  for (const scenario of scenarios) {
    const root = await createProject();
    const sleeps: number[] = [];
    const reads = [...scenario.reads];
    let branch = "";
    const commit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    };
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            return { worktree, branch, base, commits: [commit], clean: true };
          },
        },
        agentExecutor: {
          async execute() {
            return {
              outcome: "committed",
              summary: "implemented",
              commits: [commit],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          },
        },
        codeHost: {
          async createPullRequest() {
            return {
              number: 41,
              url: "https://github.com/owner/repo/pull/41",
            };
          },
          async getRequiredChecks() {
            const checks = reads.shift();
            assert.ok(checks, `${scenario.name} read beyond script`);
            return checks;
          },
        },
        clock: {
          async sleep(milliseconds) {
            sleeps.push(milliseconds);
          },
        },
      }),
    );

    assert.equal(
      result.summary.pullRequests?.[0]?.readiness,
      scenario.readiness,
    );
    assert.deepEqual(
      result.summary.pullRequests?.[0]?.failedChecks,
      scenario.failedChecks,
    );
    assert.deepEqual(sleeps, scenario.sleeps);
    assert.equal(reads.length, 0);
  }
});

test("required-check timeout enters Operator Pause", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 1 / 60_000 },
    }),
  );
  let elapsed = 0;
  let discoveryDelays = 0;
  let branch = "";
  let pauseMessage = "";
  const responses = ["", "q"];
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [commit], clean: true };
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks() {
          return [
            {
              name: "build",
              state: "IN_PROGRESS",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "pending",
            },
          ];
        },
      },
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          if (milliseconds === 30_000) discoveryDelays += 1;
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          pauseMessage = message;
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.match(pauseMessage, /Required checks timed out/u);
  assert.equal(discoveryDelays, 1);
});

test("a successful publication write is not replayed when its result audit is cancelled", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects/demo/logs");
  let branch = "";
  let pushCalls = 0;
  let damagedLog = "";
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [commit], clean: true };
        },
        async push() {
          pushCalls += 1;
          if (pushCalls === 1) {
            const [filename] = await readdir(logs);
            assert.ok(filename);
            damagedLog = path.join(logs, filename);
            await rm(damagedLog);
            await mkdir(damagedLog);
          }
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      operator: {
        async pause() {
          if (damagedLog) {
            await rm(damagedLog, { recursive: true });
            await writeFile(damagedLog, "");
            damagedLog = "";
            return "q";
          }
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pushCalls, 1);
});

test("uncertain push and Pull Request creation writes are never replayed automatically", async () => {
  for (const failedWrite of ["push", "create"] as const) {
    const root = await createProject();
    let branch = "";
    let pushCalls = 0;
    let createCalls = 0;
    const commit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    };
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            return { worktree, branch, base, commits: [commit], clean: true };
          },
          async push() {
            pushCalls += 1;
            if (failedWrite === "push") throw new Error("uncertain push");
          },
        },
        agentExecutor: {
          async execute() {
            return {
              outcome: "committed",
              summary: "implemented",
              commits: [commit],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          },
        },
        codeHost: {
          async createPullRequest() {
            createCalls += 1;
            if (failedWrite === "create") throw new Error("uncertain create");
            return {
              number: 41,
              url: "https://github.com/owner/repo/pull/41",
            };
          },
          async getRequiredChecks() {
            return [];
          },
        },
        operator: {
          async pause() {
            return failedWrite === "push"
              ? "trusted success"
              : "https://github.com/owner/repo/pull/41";
          },
        },
      }),
    );

    assert.equal(result.summary.pullRequests?.[0]?.number, 41);
    assert.equal(pushCalls, 1);
    assert.equal(createCalls, 1);
  }
});

test("Parent cancellation before publication stops without branch, PR, or child mutations", async () => {
  const root = await createProject();
  let branch = "";
  let inspected = false;
  let writes = 0;
  let releases = 0;
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          return inspected
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async removeLabel() {
          releases += 1;
        },
        async removeAssignee() {
          releases += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          inspected = true;
          return { worktree, branch, base, commits: [commit], clean: true };
        },
        async push() {
          writes += 1;
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          writes += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(writes, 0);
  assert.equal(releases, 0);
});

test("valid no_change and blocked results stay unresolved without handoffs", async () => {
  for (const scenario of [
    {
      outcome: "no_change" as const,
      summary: "the requested behavior already exists",
      blocker: null,
      expected:
        "Delivery Ticket 9 no_change: the requested behavior already exists",
      inspections: 1,
    },
    {
      outcome: "blocked" as const,
      summary: "waiting for an API decision",
      blocker: "API contract is unresolved",
      expected: "Delivery Ticket 9 blocked: API contract is unresolved",
      inspections: 0,
    },
  ]) {
    const root = await createProject();
    let inspections = 0;
    let branch = "";
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            inspections += 1;
            return {
              worktree,
              branch,
              base,
              commits: [],
              clean: true,
            };
          },
        },
        agentExecutor: {
          async execute() {
            return {
              ...scenario,
              commits: [],
              checks: [],
              pr_title: "unused metadata",
              pr_body: "unused metadata",
            };
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "incomplete");
    assert.equal(result.summary.handoffs?.length, 0);
    assert.ok(result.summary.reasons.includes(scenario.expected));
    assert.equal(inspections, scenario.inspections);
  }
});

test("false commit claims enter Operator Pause and q cancels active Sandcastle resources", async () => {
  const root = await createProject();
  let signal: AbortSignal | undefined;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: "sandcastle/mismatch",
            base,
            commits: [],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          signal = input.signal;
          return {
            outcome: "committed",
            summary: "claimed success",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: claimed commit",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: claimed commit",
            pr_body: "Claimed implementation.",
          };
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
  assert.equal(signal?.aborted, true);
});

test("empty input starts a fresh Agent Attempt with a new Git configuration", async () => {
  const root = await createProject();
  const gitConfigs: string[] = [];
  let branch = "";
  let attempt = 0;
  const { tracker } = createAttemptTracker(9);
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: retry succeeds",
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [commit], clean: true };
        },
      },
      agentExecutor: {
        async execute(input) {
          gitConfigs.push(input.gitConfigGlobal);
          attempt += 1;
          if (attempt === 1) throw new Error("Sandcastle failed");
          return {
            outcome: "committed",
            summary: "retry succeeded",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: retry succeeds",
            pr_body: "Retry implementation.",
          };
        },
      },
      operator: {
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.handoffs?.length, 1);
  assert.equal(gitConfigs.length, 2);
  assert.notEqual(gitConfigs[0], gitConfigs[1]);
  await Promise.all(
    gitConfigs.map((filename) => assert.rejects(readFile(filename, "utf8"))),
  );
});

test("a trusted committed override extracts only downstream metadata and bypasses Git verification", async () => {
  const root = await createProject();
  const responses = [
    "not json",
    JSON.stringify({
      outcome: "committed",
      pr_title: "feat: trusted result",
      pr_body: "Operator supplied metadata.",
      ignored: "not copied downstream",
    }),
  ];
  let inspections = 0;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async inspect() {
          inspections += 1;
          throw new Error("must be bypassed");
        },
      },
      agentExecutor: {
        async execute() {
          throw new Error("Sandcastle failed");
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(inspections, 0);
  assert.equal(result.summary.handoffs?.[0]?.verification, "operator_override");
  assert.equal(result.summary.handoffs?.[0]?.prTitle, "feat: trusted result");
  assert.deepEqual(result.summary.handoffs?.[0]?.commits, []);
  assert.ok(result.logPath);
  const audit = await readFile(result.logPath, "utf8");
  assert.match(audit, /operator_override/u);
  assert.equal(audit.includes("not json"), false);
  assert.equal(audit.includes("not copied downstream"), false);
});

test("a reserved Batch runs its Agent Attempts concurrently", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9, 10);
  const branches = new Map<number, string>();
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          branches.set(ticket, input.branch);
        },
        async inspect({ worktree, base }) {
          const ticket = Number(worktree.split("-").at(-1));
          const digit = ticket === 9 ? "b" : "c";
          return {
            worktree,
            branch: branches.get(ticket)!,
            base,
            commits: [
              { sha: digit.repeat(40), message: `feat: ticket ${ticket}` },
            ],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (active === 2) release?.();
          await bothStarted;
          active -= 1;
          const digit = input.ticket === 9 ? "b" : "c";
          return {
            outcome: "committed",
            summary: `implemented ${input.ticket}`,
            commits: [
              {
                sha: digit.repeat(40),
                message: `feat: ticket ${input.ticket}`,
              },
            ],
            checks: [],
            blocker: null,
            pr_title: `feat: ticket ${input.ticket}`,
            pr_body: `Implements ticket ${input.ticket}.`,
          };
        },
      },
    }),
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(
    result.summary.handoffs?.map(({ ticket }) => ticket),
    [9, 10],
  );
});

test("cancelling one concurrent Agent Attempt aborts and settles the others", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9, 10);
  let started = 0;
  let release: (() => void) | undefined;
  let abortedAttemptSettled = false;
  let activePauses = 0;
  let maxActivePauses = 0;
  let pauseCalls = 0;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute(input) {
          started += 1;
          if (started === 2) release?.();
          await bothStarted;
          if (input.ticket === 9) throw new Error("Sandcastle failed");
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => {
                abortedAttemptSettled = true;
                reject(new Error("Agent Attempt aborted"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          activePauses += 1;
          maxActivePauses = Math.max(maxActivePauses, activePauses);
          await Promise.resolve();
          activePauses -= 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(abortedAttemptSettled, true);
  assert.equal(pauseCalls, 1);
  assert.equal(maxActivePauses, 1);
});

test("Parent cancellation after Worktree preparation starts no Agent and preserves the Reservation", async () => {
  const root = await createProject();
  let worktreeCreated = false;
  let agentCalls = 0;
  let releases = 0;
  const {
    tickets: [child],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(child);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          return worktreeCreated
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async removeLabel() {
          releases += 1;
        },
        async removeAssignee() {
          releases += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree() {
          worktreeCreated = true;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not start");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 0);
  assert.equal(releases, 0);
  assert.deepEqual(child.labels, ["sandcastle:reserved"]);
  assert.deepEqual(child.assignees, ["runner"]);
});

test("a removed Reservation after Worktree preparation starts no Agent", async () => {
  const root = await createProject();
  let agentCalls = 0;
  const {
    tickets: [child],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(child);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree() {
          child.labels.length = 0;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not start");
        },
      },
    }),
  );

  assert.equal(agentCalls, 0);
  assert.ok(
    result.summary.reasons.includes(
      "Delivery Ticket 9 no longer has a complete Reservation",
    ),
  );
});

test("Agent results and trusted overrides are rejected after Parent cancellation", async () => {
  for (const trustedOverride of [false, true]) {
    const root = await createProject();
    let parentCancelled = false;
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...tracker,
          async getParent() {
            return parentCancelled
              ? { number: 8, state: "closed", stateReason: "not_planned" }
              : { number: 8, state: "open", stateReason: null };
          },
        },
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
        },
        agentExecutor: {
          async execute() {
            if (trustedOverride) throw new Error("Sandcastle failed");
            parentCancelled = true;
            return {
              outcome: "blocked",
              summary: "waiting",
              commits: [],
              checks: [],
              blocker: "waiting",
              pr_title: "unused",
              pr_body: "unused",
            };
          },
        },
        operator: {
          async pause() {
            parentCancelled = true;
            return JSON.stringify({
              outcome: "committed",
              pr_title: "feat: trusted result",
              pr_body: "Trusted result.",
            });
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "cancelled");
    assert.deepEqual(result.summary.handoffs, []);
  }
});

test("cancelling boundary revalidation after an Agent result pauses once", async () => {
  const root = await createProject();
  let agentFinished = false;
  let pauseCalls = 0;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          if (agentFinished) throw new Error("tracker unavailable");
          return { number: 8, state: "open", stateReason: null };
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          agentFinished = true;
          return {
            outcome: "blocked",
            summary: "waiting",
            commits: [],
            checks: [],
            blocker: "waiting",
            pr_title: "unused",
            pr_body: "unused",
          };
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
