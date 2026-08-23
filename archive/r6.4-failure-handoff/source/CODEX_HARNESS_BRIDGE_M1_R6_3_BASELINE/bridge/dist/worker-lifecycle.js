export function decideWorkerLiveness(active, alive, deadObservedAt, nowMs, graceMs) {
    if (!active)
        return "none";
    if (alive)
        return deadObservedAt === undefined ? "none" : "clear-dead-observation";
    if (deadObservedAt === undefined)
        return "observe-dead";
    const observedMs = Date.parse(deadObservedAt);
    if (!Number.isFinite(observedMs))
        return "observe-dead";
    return nowMs - observedMs >= graceMs ? "orphan" : "none";
}
//# sourceMappingURL=worker-lifecycle.js.map