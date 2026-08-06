import { describe, expect, it } from "vitest";

import { SecurityAnalyzer } from "../src/blockchain/security-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronAccountInfo } from "../src/blockchain/audit-model.js";
import type { AccountPermission } from "../src/blockchain/normalizers.js";

function makeAccount(overrides: Partial<TronAccountInfo> = {}): TronAccountInfo {
  return {
    address: "TAddr1",
    balanceSun: "10000000",
    balanceTrx: "10",
    createTime: null,
    latestOperationTime: null,
    isContract: false,
    accountName: null,
    frozenBalanceSun: "0",
    energyLimit: 0,
    energyUsed: 0,
    bandwidthLimit: 600,
    bandwidthUsed: 0,
    netLimit: 0,
    netUsed: 0,
    delegatedFrozenBalanceSun: "0",
    trc20Balances: [],
    permissions: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function makePermission(overrides: Partial<AccountPermission> = {}): AccountPermission {
  return {
    type: "owner",
    permissionName: "owner",
    threshold: 1,
    keys: [{ address: "TKey1", weight: 1 }],
    operations: null,
    ...overrides,
  };
}

function snapshot(accounts: Map<string, TronAccountInfo>): AuditSnapshot {
  return {
    accounts,
    tokens: new Map(),
    contracts: new Map(),
    staking: new Map(),
    governance: null,
    collectedAt: new Date(),
  };
}

describe("SecurityAnalyzer", () => {
  const analyzer = new SecurityAnalyzer();

  it("flags single-key owner accounts", () => {
    const account = makeAccount({
      permissions: [makePermission()],
    });
    const accounts = new Map([["TAddr1", account]]);

    const findings = analyzer.analyze(snapshot(accounts));

    const singleKey = findings.find((f) => f.category === "single-key-owner");
    expect(singleKey).toBeDefined();
    expect(singleKey!.severity).toBe("HIGH");
  });

  it("flags multi-sig with threshold 1", () => {
    const account = makeAccount({
      permissions: [
        makePermission({
          keys: [
            { address: "TKey1", weight: 1 },
            { address: "TKey2", weight: 1 },
            { address: "TKey3", weight: 1 },
          ],
          threshold: 1,
        }),
      ],
    });
    const accounts = new Map([["TAddr1", account]]);

    const findings = analyzer.analyze(snapshot(accounts));

    const weakMultisig = findings.find((f) => f.category === "weak-multisig-threshold");
    expect(weakMultisig).toBeDefined();
    expect(weakMultisig!.severity).toBe("HIGH");
  });

  it("reports custom active permissions as INFO", () => {
    const account = makeAccount({
      permissions: [
        makePermission({ type: "active", permissionName: "active0", operations: "7fff1fc0" }),
      ],
    });
    const accounts = new Map([["TAddr1", account]]);

    const findings = analyzer.analyze(snapshot(accounts));

    const customActive = findings.find((f) => f.category === "custom-active-permissions");
    expect(customActive).toBeDefined();
    expect(customActive!.severity).toBe("INFO");
  });

  it("flags unverified contract accounts", () => {
    const account = makeAccount({ isContract: true });
    const accounts = new Map([["TAddr1", account]]);

    const contracts = new Map([
      [
        "TAddr1",
        {
          address: "TAddr1",
          name: "TestContract",
          creatorAddress: null,
          creationTxHash: null,
          createdAt: null,
          isVerified: false,
          compilerVersion: null,
          abi: null,
          energyFactor: null,
          callCount: null,
          callerCount: null,
          collectedAt: new Date(),
          source: "test",
        },
      ],
    ]);

    const findings = analyzer.analyze({
      accounts,
      tokens: new Map(),
      contracts,
      staking: new Map(),
      governance: null,
      collectedAt: new Date(),
    });

    const unverified = findings.find((f) => f.category === "unverified-contract");
    expect(unverified).toBeDefined();
    expect(unverified!.severity).toBe("HIGH");
  });

  it("produces no findings for well-configured multi-sig", () => {
    const account = makeAccount({
      permissions: [
        makePermission({
          keys: [
            { address: "TKey1", weight: 1 },
            { address: "TKey2", weight: 1 },
            { address: "TKey3", weight: 1 },
          ],
          threshold: 2,
        }),
      ],
    });
    const accounts = new Map([["TAddr1", account]]);

    const findings = analyzer.analyze(snapshot(accounts));

    const permFindings = findings.filter(
      (f) => f.category === "single-key-owner" || f.category === "weak-multisig-threshold",
    );
    expect(permFindings).toHaveLength(0);
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("security");
    expect(analyzer.modules).toContain("RIESGO");
  });
});
