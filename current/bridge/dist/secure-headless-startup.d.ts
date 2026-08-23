export declare const name = "codex-bridge-secure-headless-startup";
interface CordisContext {
    provide(name: string, value: unknown): void;
}
/**
 * Replacement for the stock positional-argv startup provider. The prompt is
 * read only from a 0600 file inside the task sandbox and is never placed in a
 * process command line.
 */
export declare function apply(ctx: CordisContext): void;
export {};
