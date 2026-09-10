import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { executeCli, type CliDependencies } from "../../src/cli.ts";
import type {
  AgentAttemptInput,
  CommitEvidence,
  RequiredCheck,
  Ticket,
} from "../../src/run/contracts.ts";

const projectRoots = new Set<string>();

function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

test.afterEach(async () => {
  await Promise.all(
    [...projectRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  projectRoots.clear();
});

async function createProject(recovery: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-runner-full-"));
  projectRoots.add(root);
  const project = path.join(root, "projects", "demo");
  await mkdir(path.join(project, "prompts"), { recursive: true });
  const config = {
    repository: "owner/repo",
    checkout: "/tmp/repo",
    ...(!recovery && { targetBranch: "main" }),
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
    workflow: { review: false, documentationMaintenance: true },
    agents: Object.fromEntries(
      ["implement", "ciRepair", "conflictRepair", "documentation"].map(
        (name) => [name, { model: "gpt-5.6-sol", reasoningEffort: "high" }],
      ),
    ),
    timeouts: {
      agentMinutes: 120,
      requiredChecksMinutes: 60,
      mergeQueueMinutes: 60,
    },
    ticketClosure: "runner",
  };
  await writeFile(path.join(project, "config.json"), JSON.stringify(config));
  await Promise.all(
    ["implement", "ci-repair", "conflict-repair", "documentation"].map((name) =>
      writeFile(path.join(project, "prompts", `${name}.md`), `${name} prompt`),
    ),
  );
  return root;
}

function createFiveTicketScenario(root: string, recovery: boolean) {
  const parent: Ticket = { number: 8, state: "open", stateReason: null };
  const tickets = new Map<number, Ticket>(
    [1, 2, 3, 4, 5].map((number) => [
      number,
      {
        number,
        state: "open",
        stateReason: null,
        repository: "owner/repo",
        assignees: [],
        labels: [],
      },
    ]),
  );
  const maintenanceTickets: number[] = [];
  const operations: string[] = [];
  const agentCalls = new Map<string, number>();
  const checkCalls = new Map<number, number>();
  const mergeCalls = new Map<number, number>();
  const labelCalls = new Map<number, number>();
  const worktrees = new Map<
    string,
    { ticket: number; branch: string; base: string }
  >();
  const commits = new Map<number, CommitEvidence[]>();
  const branchHeads = new Map<string, string>();
  const pullRequests = new Map<
    number,
    {
      ticket: number;
      branch: string;
      headSha: string;
      createdAt: string;
      merged: boolean;
    }
  >();
  const branchPullRequests = new Map<string, number>();
  let nextMaintenanceTicket = 101;
  let nextPullRequest = 1_001;
  let resolveTargetBranchCalls = 0;
  let correctionSessions = 0;
  let trustedOverrideTicket: number | undefined;
  let activeAgents = 0;
  let maxActiveAgents = 0;
  const firstBatchStarted = new Set<number>();
  let releaseFirstBatch!: () => void;
  const firstBatchBarrier = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve;
  });

  const call = (key: string): number => {
    const value = (agentCalls.get(key) ?? 0) + 1;
    agentCalls.set(key, value);
    return value;
  };
  const sha = (value: string): string => value.repeat(40);
  const ticketForBranch = (branch: string): number =>
    Number(/(?:ticket|maintenance)-(\d+)$/u.exec(branch)?.[1]);
  const result = (input: AgentAttemptInput, commit: CommitEvidence) => ({
    outcome: "committed" as const,
    summary: `completed ${input.promptFile} for ${input.ticket}`,
    commits: [commit],
    checks: [],
    blocker: null,
    pr_title: `feat: ticket ${input.ticket}`,
    pr_body: `Completes ticket ${input.ticket}.`,
  });

  const dependencies: CliDependencies = {
    root,
    env: { TEST_GH_TOKEN: "secret" },
    tracker: {
      async getParent() {
        return parent;
      },
      async listChildrenPage() {
        return { children: [...tickets.values()].slice(0, 5), nextPage: null };
      },
      async getTicket(_repository, ticket) {
        return tickets.get(ticket)!;
      },
      async listBlockersPage(_repository, ticket) {
        return {
          blockers:
            ticket === 5
              ? [1, 2, 3, 4].map((number) => tickets.get(number)!)
              : [],
          nextPage: null,
        };
      },
      async listLabelsPage() {
        return { labels: ["doc-maintain"], nextPage: null };
      },
      async createLabel() {
        assert.fail("the existing doc-maintain label must be reused");
      },
      async createMaintenanceTicket() {
        const ticket: Ticket = {
          number: nextMaintenanceTicket,
          state: "open",
          stateReason: null,
          assignees: [],
          labels: ["doc-maintain"],
        };
        nextMaintenanceTicket += 1;
        tickets.set(ticket.number, ticket);
        maintenanceTickets.push(ticket.number);
        operations.push(`maintenance:create:${ticket.number}`);
        return ticket;
      },
      async addLabel(_repository, ticket, label) {
        const attempts = (labelCalls.get(ticket) ?? 0) + 1;
        labelCalls.set(ticket, attempts);
        operations.push(`reservation:label:${ticket}:${attempts}`);
        if (recovery && ticket === 1 && attempts === 1) {
          throw new Error("reservation write failed");
        }
        tickets.get(ticket)!.labels!.push(label);
      },
      async addAssignee(_repository, ticket, assignee) {
        tickets.get(ticket)!.assignees!.push(assignee);
      },
      async removeLabel(_repository, ticket, label) {
        const found = tickets.get(ticket)!;
        found.labels = found.labels!.filter((value) => value !== label);
      },
      async removeAssignee(_repository, ticket, assignee) {
        const found = tickets.get(ticket)!;
        found.assignees = found.assignees!.filter(
          (value) => value !== assignee,
        );
      },
      async closeTicket(_repository, ticket) {
        const found = tickets.get(ticket)!;
        found.state = "closed";
        found.stateReason = "completed";
        operations.push(`ticket:close:${ticket}`);
      },
      async closeParent() {
        parent.state = "closed";
        parent.stateReason = "completed";
        operations.push("parent:close");
      },
    },
    gitWorkspace: {
      async fetchTargetBranch() {
        operations.push("git:fetch");
        return sha("a");
      },
      async createWorktree(input) {
        const ticket = ticketForBranch(input.branch);
        worktrees.set(input.worktree, {
          ticket,
          branch: input.branch,
          base: input.base,
        });
        commits.set(ticket, []);
        operations.push(`worktree:create:${ticket}`);
      },
      async inspect(input) {
        const worktree = worktrees.get(input.worktree)!;
        return {
          worktree: input.worktree,
          branch: worktree.branch,
          base: input.base,
          commits: commits.get(worktree.ticket) ?? [],
          clean: true,
        };
      },
      async readReviewStandards() {
        return [];
      },
      async inspectReview() {
        return { clean: true, deliveryCommits: [], reviewCommits: [] };
      },
      async push(worktree) {
        const state = worktrees.get(worktree)!;
        const head = commits.get(state.ticket)?.at(-1)?.sha ?? sha("4");
        branchHeads.set(state.branch, head);
        const pullRequest = branchPullRequests.get(state.branch);
        if (pullRequest) pullRequests.get(pullRequest)!.headSha = head;
        operations.push(`push:${state.ticket}`);
      },
    },
    agentExecutor: {
      async execute(input) {
        const purpose = input.promptFile.endsWith("ci-repair.md")
          ? "ci"
          : input.promptFile.endsWith("conflict-repair.md")
            ? "conflict"
            : input.promptFile.endsWith("documentation.md")
              ? "maintenance"
              : "implement";
        const attempt = call(`${purpose}:${input.ticket}`);
        operations.push(`agent:${purpose}:${input.ticket}:${attempt}`);
        activeAgents += 1;
        maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
        try {
          if (purpose === "implement" && input.ticket <= 3 && attempt === 1) {
            firstBatchStarted.add(input.ticket);
            if (firstBatchStarted.size === 3) releaseFirstBatch();
            await firstBatchBarrier;
          }
          if (
            recovery &&
            purpose === "implement" &&
            input.ticket === 1 &&
            attempt === 1
          ) {
            throw new Error("Agent process failed");
          }
          if (recovery && purpose === "implement" && input.ticket === 4) {
            trustedOverrideTicket = 4;
            throw new Error("Agent output unavailable");
          }
          const digit =
            purpose === "ci"
              ? input.ticket === 101
                ? "d"
                : "6"
              : purpose === "conflict"
                ? input.ticket === 101
                  ? "e"
                  : "9"
                : purpose === "maintenance"
                  ? "c"
                  : String(input.ticket);
          const commit = {
            sha: sha(digit),
            message: `${purpose}: ${input.ticket}`,
          };
          if (
            recovery &&
            purpose === "implement" &&
            input.ticket === 3 &&
            attempt === 1
          ) {
            commits.set(input.ticket, [
              { sha: sha("f"), message: "unexpected commit" },
            ]);
          } else {
            commits.set(input.ticket, [commit]);
          }
          const attemptResult = result(input, commit);
          if (recovery && purpose === "implement" && input.ticket === 2) {
            const executor = new SandcastleAgentExecutor(async (options) => {
              correctionSessions += 1;
              const definition = object(options.output);
              assert.equal(definition.maxRetries, 1);
              const standard = object(object(definition.schema)["~standard"]);
              const validate = standard.validate;
              if (typeof validate !== "function")
                assert.fail("result schema must validate");
              const validateSchema = validate as (value: unknown) => unknown;
              operations.push("agent:malformed:2");
              assert.ok(
                object(await validateSchema({ ...attemptResult, summary: "" }))
                  .issues,
              );
              operations.push("agent:corrected-in-session:2");
              assert.deepEqual(await validateSchema(attemptResult), {
                value: attemptResult,
              });
              return {
                iterations: [{ sessionId: "ticket-2-session" }],
                stdout: `<agent_attempt_result>${JSON.stringify(attemptResult)}</agent_attempt_result>`,
                commits: attemptResult.commits,
                branch: input.branch,
                output: attemptResult,
              };
            });
            return executor.execute(input);
          }
          return attemptResult;
        } finally {
          activeAgents -= 1;
        }
      },
      async executeReview() {
        throw new Error("review is disabled in the V1 full-contract scenario");
      },
    },
    codeHost: {
      async resolveTargetBranch() {
        resolveTargetBranchCalls += 1;
        operations.push(`target-branch:read:${resolveTargetBranchCalls}`);
        if (recovery && resolveTargetBranchCalls < 5) {
          throw new Error("transient target-branch read");
        }
        return "main";
      },
      async createPullRequest(input) {
        const ticket = ticketForBranch(input.branch);
        const number = nextPullRequest;
        nextPullRequest += 1;
        const pullRequest = {
          ticket,
          branch: input.branch,
          headSha: branchHeads.get(input.branch) ?? sha("4"),
          createdAt: `2026-09-10T00:00:${String(ticket).padStart(2, "0")}Z`,
          merged: false,
        };
        pullRequests.set(number, pullRequest);
        branchPullRequests.set(input.branch, number);
        operations.push(`pr:create:${ticket}`);
        return {
          number,
          url: `https://github.com/owner/repo/pull/${number}`,
        };
      },
      async getRequiredChecks(_repository, pullRequest) {
        const count = (checkCalls.get(pullRequest) ?? 0) + 1;
        checkCalls.set(pullRequest, count);
        const state = pullRequests.get(pullRequest)!;
        operations.push(`checks:${state.ticket}:${count}`);
        if (recovery && state.ticket === 2 && count < 5) {
          throw new Error("transient required-check read");
        }
        const needsRepair =
          recovery &&
          ((state.ticket === 1 && state.headSha === sha("1")) ||
            (state.ticket === 101 && state.headSha === sha("c")));
        return needsRepair
          ? ([
              {
                name: "checks",
                state: "FAILURE",
                link: "https://github.com/owner/repo/actions/runs/1",
                bucket: "fail",
              },
            ] satisfies RequiredCheck[])
          : [];
      },
      async getPullRequest(_repository, pullRequest) {
        const state = pullRequests.get(pullRequest)!;
        return {
          headSha: state.headSha,
          createdAt: state.createdAt,
          merged: state.merged,
          mergeFailure: null,
        };
      },
      async requestSquashMerge({ pullRequest }) {
        const state = pullRequests.get(pullRequest)!;
        const attempt = (mergeCalls.get(pullRequest) ?? 0) + 1;
        mergeCalls.set(pullRequest, attempt);
        operations.push(`merge:${state.ticket}:${attempt}`);
        if (
          recovery &&
          attempt === 1 &&
          (state.ticket === 3 || state.ticket === 101)
        ) {
          return { outcome: "conflict", error: "scripted merge conflict" };
        }
        state.merged = true;
        return { outcome: "accepted" };
      },
    },
    clock: {
      now: () => new Date("2026-09-10T00:00:00.000Z"),
      async sleep(milliseconds) {
        operations.push(`clock:sleep:${milliseconds}`);
      },
    },
    operator: {
      write() {},
      async pause(message) {
        operations.push(`operator:pause:${message}`);
        if (trustedOverrideTicket === 4) {
          trustedOverrideTicket = undefined;
          return JSON.stringify({
            outcome: "committed",
            pr_title: "feat: trusted ticket 4",
            pr_body: "Completes ticket 4.",
          });
        }
        return "";
      },
    },
  };

  return {
    dependencies,
    operations,
    parent,
    tickets,
    maintenanceTickets,
    agentCalls,
    checkCalls,
    mergeCalls,
    labelCalls,
    get maxActiveAgents() {
      return maxActiveAgents;
    },
    get resolveTargetBranchCalls() {
      return resolveTargetBranchCalls;
    },
    get correctionSessions() {
      return correctionSessions;
    },
  };
}

function milestones(operations: string[]): string[] {
  return operations.filter(
    (operation) =>
      operation.startsWith("merge:") ||
      operation.startsWith("maintenance:create:") ||
      operation === "parent:close",
  );
}

function batchBarriers(operations: string[]): string[] {
  return operations.filter(
    (operation) =>
      operation.startsWith("maintenance:create:") ||
      operation === "reservation:label:4:1" ||
      operation === "ticket:close:4" ||
      operation === "reservation:label:5:1" ||
      operation === "ticket:close:5",
  );
}

test(
  "five Delivery Tickets complete through both maintenance barriers on the first try",
  { timeout: 5_000 },
  async () => {
    const root = await createProject(false);
    const scenario = createFiveTicketScenario(root, false);

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      scenario.dependencies,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    assert.deepEqual(result.summary.batch, [1, 2, 3, 4, 5]);
    assert.deepEqual(result.summary.completedTickets, [1, 2, 3, 4, 5]);
    assert.equal(scenario.maxActiveAgents, 3);
    assert.deepEqual(scenario.maintenanceTickets, [101, 102]);
    assert.deepEqual(milestones(scenario.operations), [
      "merge:1:1",
      "merge:2:1",
      "merge:3:1",
      "maintenance:create:101",
      "merge:101:1",
      "merge:4:1",
      "merge:5:1",
      "maintenance:create:102",
      "merge:102:1",
      "parent:close",
    ]);
    assert.deepEqual(batchBarriers(scenario.operations), [
      "maintenance:create:101",
      "reservation:label:4:1",
      "ticket:close:4",
      "reservation:label:5:1",
      "ticket:close:5",
      "maintenance:create:102",
    ]);
    assert.equal(
      [...scenario.agentCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.labelCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.checkCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.mergeCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      scenario.operations.some((value) => value.startsWith("operator:pause:")),
      false,
    );
    assert.equal(scenario.parent.stateReason, "completed");
    assert.equal(
      scenario.maintenanceTickets.every(
        (ticket) => scenario.tickets.get(ticket)?.stateReason === "completed",
      ),
      true,
    );
    assert.ok(result.logPath);
    assert.ok(result.logPath.startsWith(root));
    assert.match(
      await readFile(result.logPath, "utf8"),
      /"phase":"maintenance"/u,
    );
  },
);

test(
  "the five-ticket topology succeeds through the composed recovery path",
  { timeout: 5_000 },
  async () => {
    const root = await createProject(true);
    const scenario = createFiveTicketScenario(root, true);

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      scenario.dependencies,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    assert.deepEqual(result.summary.batch, [1, 2, 3, 4, 5]);
    assert.deepEqual(result.summary.completedTickets, [1, 2, 3, 4, 5]);
    assert.equal(scenario.resolveTargetBranchCalls, 5);
    assert.equal(scenario.labelCalls.get(1), 2);
    assert.equal(scenario.agentCalls.get("implement:1"), 2);
    assert.equal(scenario.agentCalls.get("implement:3"), 2);
    assert.equal(scenario.agentCalls.get("implement:4"), 1);
    assert.equal(scenario.correctionSessions, 1);
    assert.deepEqual(
      scenario.operations.filter(
        (operation) =>
          operation.startsWith("agent:malformed:") ||
          operation.startsWith("agent:corrected-in-session:"),
      ),
      ["agent:malformed:2", "agent:corrected-in-session:2"],
    );
    assert.equal(scenario.agentCalls.get("ci:1"), 1);
    assert.equal(scenario.agentCalls.get("conflict:3"), 1);
    assert.equal(scenario.agentCalls.get("ci:101"), 1);
    assert.equal(scenario.agentCalls.get("conflict:101"), 1);
    assert.equal(
      scenario.operations.filter((operation) =>
        operation.startsWith("checks:2:"),
      ).length,
      5,
    );
    assert.equal(
      result.summary.handoffs?.find(({ ticket }) => ticket === 4)?.verification,
      "operator_override",
    );
    assert.deepEqual(milestones(scenario.operations), [
      "merge:1:1",
      "merge:2:1",
      "merge:3:1",
      "merge:3:2",
      "maintenance:create:101",
      "merge:101:1",
      "merge:101:2",
      "merge:4:1",
      "merge:5:1",
      "maintenance:create:102",
      "merge:102:1",
      "parent:close",
    ]);
    assert.deepEqual(batchBarriers(scenario.operations), [
      "maintenance:create:101",
      "reservation:label:4:1",
      "ticket:close:4",
      "reservation:label:5:1",
      "ticket:close:5",
      "maintenance:create:102",
    ]);
    assert.equal(scenario.parent.stateReason, "completed");
    assert.equal(
      scenario.maintenanceTickets.every(
        (ticket) => scenario.tickets.get(ticket)?.stateReason === "completed",
      ),
      true,
    );
    assert.ok(result.logPath);
    const audit = await readFile(result.logPath, "utf8");
    assert.match(audit, /"result":"operator_override"/u);
    assert.equal(audit.includes("Completes ticket 4."), false);
  },
);
