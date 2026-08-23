import { spawn } from "node:child_process";
// The supervisor is deliberately the detached process-group leader. It stays
// alive after the requested command exits, so its strong /proc identity remains
// valid while the parent terminates any background descendants in that group.
process.on("SIGTERM", () => { });
let command;
process.once("message", (raw) => {
    const message = raw;
    if (!message || message.type !== "start" || typeof message.command !== "string" || !Array.isArray(message.args)) {
        process.send?.({ type: "command-error", error: "invalid supervisor start message" });
        return;
    }
    const options = {
        detached: false,
        // Inherit the supervisor's already-piped output descriptors. This avoids
        // userspace forwarding races when the parent tears down the process group
        // immediately after receiving the command-exit control message.
        stdio: [message.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    };
    if (message.cwd !== undefined)
        options.cwd = message.cwd;
    if (message.env !== undefined)
        options.env = message.env;
    command = spawn(message.command, message.args, options);
    command.once("error", (error) => process.send?.({ type: "command-error", error: error.message }));
    command.once("exit", (code, signal) => process.send?.({ type: "command-result", code, signal }));
    if (message.input !== undefined)
        command.stdin?.end(message.input);
});
process.on("disconnect", () => {
    // Losing the authenticated parent control channel is fail-closed. The
    // supervisor remains group leader until this signal tears down the group.
    try {
        process.kill(process.pid, "SIGKILL");
    }
    catch { /* exiting */ }
});
//# sourceMappingURL=run-process-supervisor.js.map