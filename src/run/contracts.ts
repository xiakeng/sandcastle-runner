export type TicketState = "open" | "closed";
export type ClosureReason = "completed" | "not_planned" | null;

export interface Ticket {
  number: number;
  state: TicketState;
  stateReason: ClosureReason;
  repository?: string;
}

export interface ChildPage {
  children: Ticket[];
  nextPage: number | null;
}

export interface Tracker {
  getParent(repository: string, parentTicket: number): Promise<Ticket>;
  listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage>;
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
