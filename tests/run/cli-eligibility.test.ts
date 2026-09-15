import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("eligibility reports ownership and Reservations after complete blocker pagination", async () => {
  const root = await createProject();
  const writes: string[] = [];
  const children = [
    { number: 9, assignees: ["developer"], labels: ["ready-for-agent"] },
    {
      number: 10,
      assignees: [],
      labels: ["sandcastle:reserved", "ready-for-agent"],
    },
    { number: 11, assignees: ["runner"], labels: ["ready-for-agent"] },
    {
      number: 12,
      assignees: ["runner"],
      labels: ["sandcastle:reserved", "ready-for-agent"],
    },
    { number: 13, assignees: [], labels: ["ready-for-agent"] },
    { number: 14, assignees: [], labels: ["ready-for-agent"] },
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
        async getTicket(_repository, ticket) {
          return children.find(({ number }) => number === ticket)!;
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
          writes.push(`label:${ticket}`);
          children
            .find(({ number }) => number === ticket)!
            .labels.push("sandcastle:reserved");
        },
        async addAssignee(_repository, ticket, assignee) {
          writes.push(`assignee:${ticket}:${assignee}`);
          children
            .find(({ number }) => number === ticket)!
            .assignees.push(assignee);
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  const events = (await readFile(result.logPath!, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          phase: string;
          operation: string;
          result: string;
          target: string;
        },
    );
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(
    events
      .filter(
        ({ phase, operation, result: eventResult }) =>
          phase === "implement" &&
          operation === "agent_attempt" &&
          eventResult === "started",
      )
      .map(({ target }) => target)
      .sort(),
    ["ticket:12", "ticket:14"],
  );
  assert.deepEqual(writes, ["label:14", "assignee:14:runner"]);
  assert.deepEqual(blockerPages.slice(0, 8), [
    "9:1",
    "10:1",
    "11:1",
    "12:1",
    "13:1",
    "13:2",
    "14:1",
    "14:2",
  ]);
  assert.ok(blockerPages.includes("12:1"));
  assert.ok(blockerPages.includes("14:1"));
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
    labels: ["ready-for-agent"],
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
    labels: ["ready-for-agent"],
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
                labels: ["sandcastle:reserved", "ready-for-agent"],
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
    labels: ["ready-for-agent"],
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
    labels: ["ready-for-agent"],
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
                labels: ["sandcastle:reserved", "ready-for-agent"],
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
    labels: ["ready-for-agent"],
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
                    labels: ["sandcastle:reserved", "ready-for-agent"],
                  }
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
    labels: ["ready-for-agent"],
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
