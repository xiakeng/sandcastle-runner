import type { CliDependencies } from "../../src/cli.ts";
import type {
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  Ticket,
  Tracker,
} from "../../src/run/contracts.ts";

export type CliDependencyOverrides = Omit<
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

export function createCliDependencies(
  root: string,
  overrides: CliDependencyOverrides = {},
): CliDependencies {
  const completedTickets = new Set<number>();
  const maintenanceTickets = new Map<number, Ticket>();
  const maintenanceWorktrees = new Map<
    string,
    { branch: string; base: string }
  >();
  let nextMaintenanceTicket = 1_000;
  const customMaintenance =
    overrides.tracker?.createMaintenanceTicket !== undefined;
  const tracker: Tracker = {
    async getParent() {
      return {
        number: 8,
        state: "open",
        stateReason: null,
        title: "Parent Ticket 8",
        body: "Governing specification.",
        source: "https://github.com/owner/repo/issues/8",
      };
    },
    async listChildrenPage() {
      return { children: [], nextPage: null };
    },
    async listLabelsPage() {
      return { labels: ["doc-maintain"], nextPage: null };
    },
    async createLabel() {},
    async addAssignee() {},
    async removeLabel() {},
    async removeAssignee() {},
    async addComment() {},
    async closeParent() {},
    ...overrides.tracker,
    async addLabel(repository, ticket, label) {
      const maintenance = maintenanceTickets.get(ticket);
      if (maintenance) {
        maintenance.labels ??= [];
        if (!maintenance.labels.includes(label)) maintenance.labels.push(label);
        return;
      }
      await overrides.tracker?.addLabel?.(repository, ticket, label);
    },
    async getTicket(repository, ticket) {
      const maintenance = maintenanceTickets.get(ticket);
      if (maintenance) return maintenance;
      return overrides.tracker?.getTicket
        ? overrides.tracker.getTicket(repository, ticket)
        : completedTickets.has(ticket)
          ? { number: ticket, state: "closed", stateReason: "completed" }
          : {
              number: ticket,
              state: "open",
              stateReason: null,
              labels: ["ready-for-agent"],
              title: `Delivery Ticket ${ticket}`,
              body: "Acceptance criteria.",
              source: `https://github.com/owner/repo/issues/${ticket}`,
            };
    },
    async listBlockersPage(repository, ticket, page) {
      if (maintenanceTickets.has(ticket))
        return { blockers: [], nextPage: null };
      return overrides.tracker?.listBlockersPage
        ? overrides.tracker.listBlockersPage(repository, ticket, page)
        : { blockers: [], nextPage: null };
    },
    async createMaintenanceTicket(repository, title, body, label) {
      const ticket = overrides.tracker?.createMaintenanceTicket
        ? await overrides.tracker.createMaintenanceTicket(
            repository,
            title,
            body,
            label,
          )
        : ({
            number: nextMaintenanceTicket,
            state: "open",
            stateReason: null,
            assignees: [],
            labels: [label],
          } satisfies Ticket);
      ticket.labels ??= [];
      if (!ticket.labels.includes(label)) ticket.labels.push(label);
      nextMaintenanceTicket += 1;
      maintenanceTickets.set(ticket.number, ticket);
      return ticket;
    },
    async closeTicket(repository, ticket) {
      const maintenance = maintenanceTickets.get(ticket);
      if (maintenance) {
        if (customMaintenance && overrides.tracker?.closeTicket) {
          await overrides.tracker.closeTicket(repository, ticket);
        } else {
          maintenance.state = "closed";
          maintenance.stateReason = "completed";
        }
        return;
      }
      if (overrides.tracker?.closeTicket) {
        await overrides.tracker.closeTicket(repository, ticket);
        return;
      }
      completedTickets.add(ticket);
    },
  };
  let merged = false;
  const codeHost: CodeHost = {
    async resolveTargetBranch() {
      return "ignored";
    },
    async createPullRequest() {
      return { number: 1, url: "https://github.com/owner/repo/pull/1" };
    },
    async getRemoteBranchHead() {
      return null;
    },
    async listPullRequests() {
      return [];
    },
    async getRequiredChecks() {
      return [];
    },
    async getPullRequest() {
      return {
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: "2026-09-09T00:00:00Z",
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
    async push() {},
    async readReviewStandards() {
      return [];
    },
    async inspectReview() {
      return { clean: true, deliveryCommits: [], reviewCommits: [] };
    },
    ...overrides.gitWorkspace,
    async createWorktree(input) {
      if (input.worktree.includes("/maintenance-")) {
        maintenanceWorktrees.set(input.worktree, {
          branch: input.branch,
          base: input.base,
        });
        if (!customMaintenance) return;
      }
      await overrides.gitWorkspace?.createWorktree?.(input);
    },
    async inspect(input) {
      const maintenance = maintenanceWorktrees.get(input.worktree);
      if (maintenance && !customMaintenance) {
        return {
          worktree: input.worktree,
          branch: maintenance.branch,
          base: maintenance.base,
          commits: [],
          clean: true,
        };
      }
      if (overrides.gitWorkspace?.inspect)
        return overrides.gitWorkspace.inspect(input);
      return {
        worktree: input.worktree,
        branch: "unused",
        base: input.base,
        commits: [],
        clean: true,
      };
    },
  };
  const agentExecutor: AgentExecutor = {
    ...overrides.agentExecutor,
    async execute(input) {
      if (maintenanceTickets.has(input.ticket) && !customMaintenance) {
        return {
          outcome: "no_change",
          summary: "documentation is current",
          commits: [],
          checks: [],
          blocker: null,
        };
      }
      if (overrides.agentExecutor?.execute)
        return overrides.agentExecutor.execute(input);
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
    async executeReview(input) {
      if (overrides.agentExecutor?.executeReview)
        return overrides.agentExecutor.executeReview(input);
      return {
        outcome: "blocked",
        summary: "not enabled for this scenario",
        standards: { verdict: "blocked", unresolved_findings: [] },
        spec: { verdict: "blocked", unresolved_findings: [] },
        checks: [],
        blocker: "not enabled for this scenario",
      };
    },
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

export function createAttemptTracker(...numbers: number[]): {
  tickets: {
    number: number;
    state: "open" | "closed";
    stateReason: null | "completed" | "not_planned";
    repository: string;
    assignees: string[];
    labels: string[];
    title?: string;
    body?: string;
    source?: string;
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
    title?: string;
    body?: string;
    source?: string;
  }[] = numbers.map((number) => ({
    number,
    state: "open",
    stateReason: null,
    repository: "owner/repo",
    assignees: [] as string[],
    labels: ["ready-for-agent"] as string[],
    title: `Delivery Ticket ${number}`,
    body: "Acceptance criteria.",
    source: `https://github.com/owner/repo/issues/${number}`,
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
      async addComment() {},
      async closeTicket(_repository, ticket) {
        const found = tickets.find(({ number }) => number === ticket)!;
        found.state = "closed";
        found.stateReason = "completed";
      },
    },
  };
}

export function createCommittedDelivery(ticket = 9): {
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

export function createCommittedBatch(...numbers: number[]) {
  const { tracker, tickets } = createAttemptTracker(...numbers);
  const branches = new Map<number, string>();
  return {
    tracker,
    tickets,
    gitWorkspace: {
      async fetchTargetBranch() {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async createWorktree(
        input: Parameters<GitWorkspace["createWorktree"]>[0],
      ) {
        branches.set(Number(input.branch.split("-").at(-1)), input.branch);
      },
      async inspect({
        worktree,
        base,
      }: Parameters<GitWorkspace["inspect"]>[0]) {
        const ticket = Number(worktree.split("-").at(-1));
        return {
          worktree,
          branch: branches.get(ticket)!,
          base,
          commits: [
            {
              sha: String(ticket).at(-1)!.repeat(40),
              message: `feat: ticket ${ticket}`,
            },
          ],
          clean: true,
        };
      },
    } satisfies Partial<GitWorkspace>,
    agentExecutor: {
      async execute(input: Parameters<AgentExecutor["execute"]>[0]) {
        return {
          outcome: "committed" as const,
          summary: `implemented ${input.ticket}`,
          commits: [
            {
              sha: String(input.ticket).at(-1)!.repeat(40),
              message: `feat: ticket ${input.ticket}`,
            },
          ],
          checks: [],
          blocker: null,
          pr_title: `feat: ticket ${input.ticket}`,
          pr_body: `Implements ticket ${input.ticket}.`,
        };
      },
    } satisfies Partial<AgentExecutor>,
  };
}
