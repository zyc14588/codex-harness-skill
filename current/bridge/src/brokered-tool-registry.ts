import { randomUUID } from "node:crypto";
import type { ProcessIdentity } from "./types.js";

export interface BrokeredToolRegistryEntry {
  requestId: string;
  taskId: string;
  attemptId: string;
  registeredAt: string;
  processIdentity?: ProcessIdentity;
}

interface MutableEntry extends BrokeredToolRegistryEntry {
  controller: AbortController;
  signal: AbortSignal;
}

export interface BrokeredToolRegistryLease {
  requestId: string;
  signal: AbortSignal;
  bindProcess(identity: ProcessIdentity): void;
  close(): void;
}

export class BrokeredToolProcessRegistry {
  readonly #entries = new Map<string, MutableEntry>();

  open(taskId: string, attemptId: string, requestSignal: AbortSignal): BrokeredToolRegistryLease {
    if (requestSignal.aborted) throw new Error("brokered tool request was already aborted");
    const requestId = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const entry: MutableEntry = {
      requestId,
      taskId,
      attemptId,
      registeredAt: new Date().toISOString(),
      controller,
      signal,
    };
    this.#entries.set(requestId, entry);
    let closed = false;
    return {
      requestId,
      signal,
      bindProcess: (identity) => {
        if (closed || this.#entries.get(requestId) !== entry) throw new Error("brokered tool registry lease is no longer active");
        entry.processIdentity = identity;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#entries.delete(requestId);
      },
    };
  }

  snapshot(): BrokeredToolRegistryEntry[] {
    return [...this.#entries.values()].map(({ controller: _controller, signal: _signal, ...entry }) => ({ ...entry }));
  }

  abortRequest(requestId: string, reason = "brokered tool request cancelled"): boolean {
    const entry = this.#entries.get(requestId);
    if (!entry || entry.signal.aborted) return false;
    entry.controller.abort(reason);
    return true;
  }

  abortTask(taskId: string, reason = "brokered tool task became terminal"): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.taskId === taskId && !entry.signal.aborted) {
        entry.controller.abort(reason);
        count += 1;
      }
    }
    return count;
  }

  abortAttemptMismatch(taskId: string, activeAttemptId: string | undefined): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.taskId === taskId && entry.attemptId !== activeAttemptId && !entry.signal.aborted) {
        entry.controller.abort("brokered tool attempt changed");
        count += 1;
      }
    }
    return count;
  }

  abortAll(reason = "Monitor shutdown"): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (!entry.signal.aborted) {
        entry.controller.abort(reason);
        count += 1;
      }
    }
    return count;
  }

  async waitForEmpty(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#entries.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.#entries.size === 0;
  }
}

export const brokeredToolProcessRegistry = new BrokeredToolProcessRegistry();
