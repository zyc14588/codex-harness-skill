import type { BridgeConfig } from "./types.js";
export interface CostAdjustment {
    id: string;
    at: string;
    budgetGroupId: string;
    actor: "dashboard" | "cli";
    reason: string;
    currency?: "CNY" | "USD";
    rawCostCnyAtAdjustment?: number;
    previousManualAdjustmentCny?: number;
    beforeAdjustedCostCny?: number;
    requestedCorrectedCostCny?: number;
    deltaCny?: number;
    /** Legacy M1-R2 fields retained for append-only ledger compatibility. */
    rawCostUsdAtAdjustment?: number;
    previousManualAdjustmentUsd?: number;
    beforeAdjustedCostUsd?: number;
    requestedCorrectedCostUsd?: number;
    deltaUsd?: number;
}
export interface FxRateState {
    usdToCnyRate: number | null;
    asOf: string;
    source: string;
    updatedAt?: string;
    updatedBy: "config" | "dashboard" | "cli";
}
export declare function listCostAdjustments(config: BridgeConfig, limit?: number): Promise<CostAdjustment[]>;
export declare function readFxRateState(config: BridgeConfig): Promise<FxRateState>;
export declare function usdToCny(usd: number, rate: number | null): number | null;
export declare function manualAdjustmentCnyForGroup(config: BridgeConfig, budgetGroupId: string): Promise<number>;
export declare function manualAdjustmentUsdForGroup(config: BridgeConfig, budgetGroupId: string): Promise<number>;
export declare function setCorrectedBudgetGroupCostCny(config: BridgeConfig, budgetGroupId: string, correctedCostCny: number, reason: string, actor: "dashboard" | "cli"): Promise<CostAdjustment>;
/** Legacy CLI compatibility. New dashboard code uses the CNY function above. */
export declare function setCorrectedBudgetGroupCost(config: BridgeConfig, budgetGroupId: string, correctedCostUsd: number, reason: string, actor: "dashboard" | "cli"): Promise<CostAdjustment>;
export declare function setFxRateState(config: BridgeConfig, usdToCnyRate: number | null, asOf: string, source: string, actor: "dashboard" | "cli"): Promise<FxRateState>;
