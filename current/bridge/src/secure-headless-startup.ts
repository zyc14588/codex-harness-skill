import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const name = "codex-bridge-secure-headless-startup";

interface CordisContext {
  provide(name: string, value: unknown): void;
}

/**
 * Replacement for the stock positional-argv startup provider. The prompt is
 * read only from a 0600 file inside the task sandbox and is never placed in a
 * process command line.
 */
export function apply(ctx: CordisContext): void {
  const configured = process.env.CODEX_HARNESS_PROMPT_FILE;
  const sandboxRoot = process.env.CODEX_HARNESS_SANDBOX_ROOT;
  if (!configured || !sandboxRoot || !path.isAbsolute(configured) || !path.isAbsolute(sandboxRoot)) {
    throw new Error("SECURE_PROMPT_INPUT: prompt file or sandbox root is unavailable");
  }
  const canonicalRoot = realpathSync(sandboxRoot);
  const canonicalPrompt = realpathSync(configured);
  const relative = path.relative(canonicalRoot, canonicalPrompt);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("SECURE_PROMPT_INPUT: prompt file resolves outside the task sandbox");
  }
  const info = lstatSync(canonicalPrompt);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 256_000) {
    throw new Error("SECURE_PROMPT_INPUT: prompt must be a 0600 regular file no larger than 256000 bytes");
  }
  const task = readFileSync(canonicalPrompt, "utf8");
  if (!task.trim() || task.includes("\0")) throw new Error("SECURE_PROMPT_INPUT: prompt is empty or contains NUL");
  ctx.provide("headlessStartup", { task });
}
