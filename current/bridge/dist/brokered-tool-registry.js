import { randomUUID } from "node:crypto";
export class BrokeredToolProcessRegistry {
    #entries = new Map();
    open(taskId, attemptId, requestSignal) {
        if (requestSignal.aborted)
            throw new Error("brokered tool request was already aborted");
        const requestId = randomUUID();
        const controller = new AbortController();
        const signal = AbortSignal.any([requestSignal, controller.signal]);
        const entry = {
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
                if (closed || this.#entries.get(requestId) !== entry)
                    throw new Error("brokered tool registry lease is no longer active");
                entry.processIdentity = identity;
            },
            close: () => {
                if (closed)
                    return;
                closed = true;
                this.#entries.delete(requestId);
            },
        };
    }
    snapshot() {
        return [...this.#entries.values()].map(({ controller: _controller, signal: _signal, ...entry }) => ({ ...entry }));
    }
    abortRequest(requestId, reason = "brokered tool request cancelled") {
        const entry = this.#entries.get(requestId);
        if (!entry || entry.signal.aborted)
            return false;
        entry.controller.abort(reason);
        return true;
    }
    abortTask(taskId, reason = "brokered tool task became terminal") {
        let count = 0;
        for (const entry of this.#entries.values()) {
            if (entry.taskId === taskId && !entry.signal.aborted) {
                entry.controller.abort(reason);
                count += 1;
            }
        }
        return count;
    }
    abortAttemptMismatch(taskId, activeAttemptId) {
        let count = 0;
        for (const entry of this.#entries.values()) {
            if (entry.taskId === taskId && entry.attemptId !== activeAttemptId && !entry.signal.aborted) {
                entry.controller.abort("brokered tool attempt changed");
                count += 1;
            }
        }
        return count;
    }
    abortAll(reason = "Monitor shutdown") {
        let count = 0;
        for (const entry of this.#entries.values()) {
            if (!entry.signal.aborted) {
                entry.controller.abort(reason);
                count += 1;
            }
        }
        return count;
    }
    async waitForEmpty(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (this.#entries.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return this.#entries.size === 0;
    }
}
export const brokeredToolProcessRegistry = new BrokeredToolProcessRegistry();
//# sourceMappingURL=brokered-tool-registry.js.map