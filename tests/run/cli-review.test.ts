import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import type { AgentExecutor } from "../../src/run/contracts.ts";

test.afterEach(cleanupTempRoots);

test("default-enabled review reports its required profile and prompt paths", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  const defaulted = config as Partial<typeof config> & {
    agents: Partial<typeof config.agents>;
  };
  delete defaulted.workflow;
  delete defaulted.agents.review;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  await rm(path.join(root, "projects/demo/prompts/review.md"));

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Review is enabled.*agents\.review.*prompts\/review\.md/u,
  );
});

test("disabled review does not read its prompt but validates a supplied profile", async () => {
  const root = await createProject();
  await rm(path.join(root, "projects/demo/prompts/review.md"));

  const disabled = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );
  assert.equal(disabled.summary.outcome, "no_work");

  const config = structuredClone(validConfig);
  config.agents.review = { model: "unsupported", reasoningEffort: "high" };
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  const invalid = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );
  assert.match(
    invalid.summary.reasons[0] ?? "",
    /agents\.review\.model is unsupported/u,
  );
});

test("a clean fresh-context review gates publication and preserves implementation metadata", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.review = true;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  let reviewInput: Parameters<AgentExecutor["executeReview"]>[0] | undefined;
  let branch = "";
  const operations: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return {
            number: 8,
            state: "open",
            stateReason: null,
            title: "Parent specification",
            body: "Accepted specification body.",
            source: "https://github.com/owner/repo/issues/8",
          };
        },
        async getTicket(_repository, ticket) {
          return {
            ...delivery.tickets.find(({ number }) => number === ticket)!,
            title: "Delivery ticket",
            body: "Acceptance criteria body.",
            source: "https://github.com/owner/repo/issues/9",
          };
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
          return {
            worktree,
            branch,
            base,
            commits: [implementation],
            clean: true,
          };
        },
        async readReviewStandards(worktree) {
          return [
            {
              source: path.join(worktree, "AGENTS.md"),
              content: "Review both Standards and Spec.",
            },
          ];
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [implementation],
            reviewCommits: [],
          };
        },
        async push() {
          operations.push("push");
        },
      },
      agentExecutor: {
        async execute(input) {
          return delivery.agentExecutor.execute!(input);
        },
        async executeReview(input) {
          operations.push("review");
          reviewInput = input;
          return {
            outcome: "passed",
            summary: "Both review axes pass.",
            standards: { verdict: "passed", unresolved_findings: [] },
            spec: { verdict: "passed", unresolved_findings: [] },
            checks: [
              { command: "npm test", status: "passed", details: "all passed" },
            ],
            blocker: null,
          };
        },
      },
      codeHost: {
        async createPullRequest(input) {
          operations.push(`pr:${input.title}:${input.body}`);
          return { number: 1, url: "https://github.com/owner/repo/pull/1" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(operations.slice(0, 3), [
    "review",
    "push",
    "pr:feat: implementation:Implementation body.",
  ]);
  assert.ok(reviewInput);
  assert.deepEqual(Object.keys(reviewInput.promptArgs), ["REVIEW_HANDOFF"]);
  const reviewHandoff = JSON.parse(
    String(reviewInput.promptArgs.REVIEW_HANDOFF),
  ) as Record<string, unknown>;
  assert.equal(
    reviewInput.promptFile,
    path.join(root, "projects/demo/prompts/review.md"),
  );
  assert.equal(reviewInput.base, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(reviewInput.branch, branch);
  assert.deepEqual(reviewHandoff.deliveryTicket, {
    source: "https://github.com/owner/repo/issues/9",
    title: "Delivery ticket",
    body: "Acceptance criteria body.",
  });
  assert.deepEqual(reviewHandoff.governingSpecification, {
    source: "https://github.com/owner/repo/issues/8",
    title: "Parent specification",
    body: "Accepted specification body.",
  });
  assert.equal(
    JSON.stringify(reviewHandoff).includes("Implementation body."),
    false,
  );
  assert.deepEqual(result.summary.handoffs?.[0]?.reviewCommits, []);
});

test("review fix commits become part of the complete delivery without replacing implementation identity", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.review = true;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const fix = { sha: "c".repeat(40), message: "fix: review finding" };
  let branch = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits: [implementation],
            clean: true,
          };
        },
        async readReviewStandards() {
          return [];
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [implementation, fix],
            reviewCommits: [fix],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          return delivery.agentExecutor.execute!(input);
        },
        async executeReview() {
          return {
            outcome: "passed",
            summary: "Fixed one finding.",
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
  assert.deepEqual(result.summary.handoffs?.[0]?.commits, [
    implementation,
    fix,
  ]);
  assert.deepEqual(result.summary.handoffs?.[0]?.implementationCommits, [
    implementation,
  ]);
  assert.deepEqual(result.summary.handoffs?.[0]?.reviewCommits, [fix]);
  assert.equal(result.summary.handoffs?.[0]?.prTitle, "feat: implementation");
});

test("blocked, dirty, or invalid review pauses before publication", async () => {
  for (const failure of ["blocked", "dirty", "invalid"] as const) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.workflow.review = true;
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify(config),
    );
    const delivery = createCommittedDelivery(9);
    let pushes = 0;
    let pauses = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async readReviewStandards() {
            return [];
          },
          async inspectReview() {
            return {
              clean: failure !== "dirty",
              deliveryCommits: [],
              reviewCommits: [],
            };
          },
          async push() {
            pushes += 1;
          },
        },
        agentExecutor: {
          async execute(input) {
            return delivery.agentExecutor.execute!(input);
          },
          async executeReview() {
            if (failure === "invalid")
              throw new Error("second invalid review result");
            return failure === "blocked"
              ? {
                  outcome: "blocked",
                  summary: "Review cannot pass.",
                  standards: {
                    verdict: "blocked",
                    unresolved_findings: ["P1 unresolved"],
                  },
                  spec: { verdict: "passed", unresolved_findings: [] },
                  checks: [],
                  blocker: "P1 unresolved",
                }
              : {
                  outcome: "passed",
                  summary: "Axes pass but files are dirty.",
                  standards: { verdict: "passed", unresolved_findings: [] },
                  spec: { verdict: "passed", unresolved_findings: [] },
                  checks: [],
                  blocker: null,
                };
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
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(pauses, 1);
    assert.equal(pushes, 0);
  }
});

test("review retry uses a fresh attempt and verifies the Worktree", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.review = true;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const fix = { sha: "c".repeat(40), message: "fix: review finding" };
  const gitConfigs: string[] = [];
  let reviews = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async readReviewStandards() {
          return [];
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [implementation, fix],
            reviewCommits: [fix],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          return delivery.agentExecutor.execute!(input);
        },
        async executeReview(input) {
          gitConfigs.push(input.gitConfigGlobal);
          reviews += 1;
          if (reviews === 2) {
            return {
              outcome: "passed",
              summary: "review passed",
              standards: { verdict: "passed", unresolved_findings: [] },
              spec: { verdict: "passed", unresolved_findings: [] },
              checks: [],
              blocker: null,
            };
          }
          throw new Error("review failed after committing a fix");
        },
      },
      operator: {
        async pause() {
          return reviews === 1 ? "" : "trusted passing result";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(reviews, 2);
  assert.notEqual(gitConfigs[0], gitConfigs[1]);
  assert.deepEqual(result.summary.handoffs?.[0]?.commits, [
    implementation,
    fix,
  ]);
  assert.deepEqual(result.summary.handoffs?.[0]?.reviewCommits, [fix]);
  assert.equal(result.summary.handoffs?.[0]?.reviewVerification, "verified");
});

test("a trusted review result cannot bypass the clean Worktree gate", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.review = true;
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify(config),
  );
  const delivery = createCommittedDelivery(9);
  let pauses = 0;
  let pushes = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async readReviewStandards() {
          return [];
        },
        async inspectReview() {
          return { clean: false, deliveryCommits: [], reviewCommits: [] };
        },
        async push() {
          pushes += 1;
        },
      },
      agentExecutor: {
        async execute(input) {
          return delivery.agentExecutor.execute!(input);
        },
        async executeReview() {
          throw new Error("review failed");
        },
      },
      operator: {
        async pause() {
          pauses += 1;
          return pauses === 1 ? "trusted passing result" : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses, 2);
  assert.equal(pushes, 0);
  assert.match(await readFile(result.logPath!, "utf8"), /operator_pause/u);
});
