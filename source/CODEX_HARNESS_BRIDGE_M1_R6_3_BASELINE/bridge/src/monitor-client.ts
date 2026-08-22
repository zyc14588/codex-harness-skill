import { ensureMonitorRunning, pingMonitor } from "./monitor.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { monitorSnapshot, monitorStop } from "./service.js";
import { setCorrectedBudgetGroupCostCny, setFxRateState } from "./adjustments.js";

const command = process.argv[2] ?? "status";
const config = await loadConfig();
let result: unknown;
switch (command) {
  case "start":
    result = { ...(await ensureMonitorRunning(config, defaultConfigPath())), ...(await pingMonitor(config)) };
    break;
  case "status":
    result = await pingMonitor(config);
    break;
  case "snapshot":
    result = await monitorSnapshot(200);
    break;
  case "stop":
    result = await monitorStop();
    break;
  case "correct-cost": {
    const budgetGroupId = process.argv[3];
    const rawCost = process.argv[4];
    const reason = process.argv.slice(5).join(" ");
    if (!budgetGroupId || !rawCost || !reason) throw new Error("usage: monitor-client.js correct-cost <budgetGroupId> <correctedCostCny> <reason>");
    const correctedCostCny = Number(rawCost);
    if (!Number.isFinite(correctedCostCny) || correctedCostCny < 0) throw new Error("correctedCostCny must be a finite non-negative number");
    result = await setCorrectedBudgetGroupCostCny(config, budgetGroupId, correctedCostCny, reason, "cli");
    break;
  }
  case "set-fx": {
    const rawRate = process.argv[3];
    const asOf = process.argv[4];
    const source = process.argv.slice(5).join(" ");
    if (!rawRate || !asOf || !source) throw new Error("usage: monitor-client.js set-fx <usdToCnyRate|none> <asOf> <source>");
    const rate = rawRate.toLowerCase() === "none" ? null : Number(rawRate);
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) throw new Error("usdToCnyRate must be a positive number or none");
    result = await setFxRateState(config, rate, asOf, source, "cli");
    break;
  }
  default:
    throw new Error("usage: monitor-client.js start|status|snapshot|stop|correct-cost|set-fx");
}
const exitCode = command === "status" && (!result || typeof result !== "object" || (result as Record<string, unknown>).ok !== true) ? 1 : 0;
// Explicitly terminate after stdout flush. Node fetch may retain an idle HTTP handle after
// monitor health/stop requests; a CLI command must never keep install or uninstall blocked.
await new Promise<void>((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
process.exit(exitCode);
