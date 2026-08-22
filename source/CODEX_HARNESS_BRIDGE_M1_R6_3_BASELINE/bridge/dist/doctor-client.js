import os from "node:os";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "./config.js";
import { parseToolPayload, StdioMcpClient } from "./stdio-client.js";
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const client = await StdioMcpClient.connect(process.execPath, [serverPath], {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    CODEX_HARNESS_CONFIG: process.env.CODEX_HARNESS_CONFIG ?? defaultConfigPath(),
});
try {
    const result = await client.callTool("bridge_doctor", { probeHarness: true }, 120_000);
    const payload = parseToolPayload(result, true);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (result.isError || payload.ok !== true)
        process.exitCode = 1;
}
finally {
    await client.close();
}
//# sourceMappingURL=doctor-client.js.map