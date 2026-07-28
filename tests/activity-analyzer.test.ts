import { describe, expect, it } from "vitest";

import { ActivityAnalyzer } from "../src/blockchain/activity-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type {
  TronAccountInfo,
  TronContractInfo,
} from "../src/blockchain/audit-model.js";

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

function makeContract(
  overrides: Partial<TronContractInfo> = {},
): TronContractInfo {
  return {
    address: "TContract1",
    name: "TestContract",
    creatorAddress: "TCreator",
    creationTxHash: "abc123",
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    isVerified: true,
    compilerVersion: "0.8.0",
    abi: [],
    energyFactor: null,
    callCount: 1000,
    callerCount: 500,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function snapshot(
  accounts: Map<string, TronAccountInfo> = new Map(),
  contracts: Map<string, TronContractInfo> = new Map(),
  governance: AuditSnapshot["governance"] = null,
): AuditSnapshot {
  return {
    accounts,
    tokens: new Map(),
    contracts,
    staking: new Map(),
    governance,
    collectedAt: new Date(),
  };
}

describe("ActivityAnalyzer", () => {
  const analyzer = new ActivityAnalyzer();

  it("flags long-inactive accounts (> 180 days, age > 30 days)", () => {
    const now = Date.now();
    const accounts = new Map([
      [
        "T1",
        makeAccount({
          createTime: now - 365 * 24 * 60 * 60 * 1000,
          latestOperationTime: now - 200 * 24 * 60 * 60 * 1000,
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const inactive = findings.find(
      (f) => f.category === "long-inactive-account",
    );
    expect(inactive).toBeDefined();
    expect(inactive!.severity).toBe("LOW");
  });

  it("does not flag recently active accounts", () => {
    const now = Date.now();
    const accounts = new Map([
      [
        "T1",
        makeAccount({
          createTime: now - 365 * 24 * 60 * 60 * 1000,
          latestOperationTime: now - 10 * 24 * 60 * 60 * 1000,
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const inactive = findings.find(
      (f) => f.category === "long-inactive-account",
    );
    expect(inactive).toBeUndefined();
  });

  it("skips accounts with null createTime or latestOperationTime", () => {
    const accounts = new Map([
      ["T1", makeAccount({ createTime: null, latestOperationTime: null })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const inactive = findings.find(
      (f) => f.category === "long-inactive-account",
    );
    expect(inactive).toBeUndefined();
  });

  it("flags new high-value accounts (< 7 days, > 100K TRX)", () => {
    const now = Date.now();
    const accounts = new Map([
      [
        "T1",
        makeAccount({
          createTime: now - 3 * 24 * 60 * 60 * 1000,
          latestOperationTime: now - 1 * 24 * 60 * 60 * 1000,
          balanceSun: "200000000000",
          balanceTrx: "200000",
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const newHigh = findings.find(
      (f) => f.category === "new-high-value-account",
    );
    expect(newHigh).toBeDefined();
    expect(newHigh!.severity).toBe("MEDIUM");
  });

  it("does not flag old high-value accounts", () => {
    const now = Date.now();
    const accounts = new Map([
      [
        "T1",
        makeAccount({
          createTime: now - 30 * 24 * 60 * 60 * 1000,
          latestOperationTime: now - 1 * 24 * 60 * 60 * 1000,
          balanceSun: "200000000000",
          balanceTrx: "200000",
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const newHigh = findings.find(
      (f) => f.category === "new-high-value-account",
    );
    expect(newHigh).toBeUndefined();
  });

  it("flags single-caller contracts", () => {
    const contracts = new Map([
      [
        "T1",
        makeContract({
          address: "T1",
          callCount: 500,
          callerCount: 1,
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(new Map(), contracts));

    const singleCaller = findings.find(
      (f) => f.category === "single-caller-contract",
    );
    expect(singleCaller).toBeDefined();
    expect(singleCaller!.severity).toBe("MEDIUM");
  });

  it("does not flag contracts with many callers", () => {
    const contracts = new Map([
      [
        "T1",
        makeContract({
          address: "T1",
          callCount: 500,
          callerCount: 100,
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(new Map(), contracts));

    const singleCaller = findings.find(
      (f) => f.category === "single-caller-contract",
    );
    expect(singleCaller).toBeUndefined();
  });

  it("flags concentrated contract usage", () => {
    const contracts = new Map([
      [
        "T1",
        makeContract({
          address: "T1",
          callCount: 50000,
          callerCount: 5,
        }),
      ],
    ]);
    const findings = analyzer.analyze(snapshot(new Map(), contracts));

    const concentrated = findings.find(
      (f) => f.category === "concentrated-contract-usage",
    );
    expect(concentrated).toBeDefined();
    expect(concentrated!.severity).toBe("LOW");
  });

  it("flags low network productivity", () => {
    const governance: AuditSnapshot["governance"] = {
      witnesses: [
        {
          address: "TSR1",
          url: "http://sr1.example.com",
          voteCount: 100000,
          isElected: true,
          productivityPct: 85,
          totalMissed: 150,
          totalProduced: 850,
          latestBlockNum: 100,
        },
        {
          address: "TSR2",
          url: "http://sr2.example.com",
          voteCount: 90000,
          isElected: true,
          productivityPct: 90,
          totalMissed: 100,
          totalProduced: 900,
          latestBlockNum: 99,
        },
      ],
      proposals: [],
      chainParameters: {},
      totalVotes: 190000,
      electedCount: 2,
      collectedAt: new Date(),
      source: "test",
    };

    const findings = analyzer.analyze(snapshot(new Map(), new Map(), governance));

    const lowProd = findings.find(
      (f) => f.category === "low-network-productivity",
    );
    expect(lowProd).toBeDefined();
    expect(lowProd!.severity).toBe("MEDIUM");
  });

  it("does not flag healthy network productivity", () => {
    const governance: AuditSnapshot["governance"] = {
      witnesses: [
        {
          address: "TSR1",
          url: "http://sr1.example.com",
          voteCount: 100000,
          isElected: true,
          productivityPct: 99,
          totalMissed: 10,
          totalProduced: 990,
          latestBlockNum: 100,
        },
        {
          address: "TSR2",
          url: "http://sr2.example.com",
          voteCount: 90000,
          isElected: true,
          productivityPct: 98,
          totalMissed: 20,
          totalProduced: 980,
          latestBlockNum: 99,
        },
      ],
      proposals: [],
      chainParameters: {},
      totalVotes: 190000,
      electedCount: 2,
      collectedAt: new Date(),
      source: "test",
    };

    const findings = analyzer.analyze(snapshot(new Map(), new Map(), governance));

    const lowProd = findings.find(
      (f) => f.category === "low-network-productivity",
    );
    expect(lowProd).toBeUndefined();
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("activity");
    expect(analyzer.modules).toContain("ON_CHAIN");
    expect(analyzer.modules).toContain("FUNDAMENTAL");
  });
});
