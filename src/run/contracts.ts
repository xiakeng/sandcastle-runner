export type TicketState = "open" | "closed";
export type ClosureReason = "completed" | "not_planned" | null;

export interface Ticket {
  number: number;
  state: TicketState;
  stateReason: ClosureReason;
  repository?: string;
  assignees?: string[];
  labels?: string[];
}

export interface ChildPage {
  children: Ticket[];
  nextPage: number | null;
}

export interface BlockerPage {
  blockers: Ticket[];
  nextPage: number | null;
}

export interface Tracker {
  getParent(repository: string, parentTicket: number): Promise<Ticket>;
  listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage>;
  getTicket(repository: string, ticket: number): Promise<Ticket>;
  listBlockersPage(
    repository: string,
    ticket: number,
    page: number,
  ): Promise<BlockerPage>;
  addLabel(repository: string, ticket: number, label: string): Promise<void>;
  addAssignee(
    repository: string,
    ticket: number,
    assignee: string,
  ): Promise<void>;
  removeLabel(repository: string, ticket: number, label: string): Promise<void>;
  removeAssignee(
    repository: string,
    ticket: number,
    assignee: string,
  ): Promise<void>;
  closeParent(repository: string, parentTicket: number): Promise<void>;
}

export interface CodeHost {
  resolveTargetBranch(repository: string): Promise<string>;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface OperatorIO {
  write(message: string): void;
  pause(message: string): Promise<string | null>;
}
