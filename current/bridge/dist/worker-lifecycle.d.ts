/**
 * Decide how a controller should react to one worker-liveness observation.
 *
 * A dead PID is not itself proof that an active task is orphaned: the worker
 * may have atomically published its terminal task record immediately before
 * exiting while the controller still holds a stale active snapshot.  The
 * first dead observation therefore records a timestamp.  Only a later
 * observation, after the grace interval and after reloading the task, may mark
 * the task orphaned.
 */
export type WorkerLivenessDecision = "none" | "observe-dead" | "clear-dead-observation" | "orphan";
export declare function decideWorkerLiveness(active: boolean, alive: boolean, deadObservedAt: string | undefined, nowMs: number, graceMs: number): WorkerLivenessDecision;
