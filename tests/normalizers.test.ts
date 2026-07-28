import { describe, expect, it } from "vitest";

import {
  AddressCodec,
  AmountNormalizer,
  ContractClassifier,
  TimestampNormalizer,
  PermissionParser,
} from "../src/blockchain/normalizers.js";

// ── AddressCodec ──

describe("AddressCodec", () => {
  const KNOWN_HEX = "410000000000000000000000000000000000000000";
  const KNOWN_BASE58 = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

  const FOUNDATION_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
  const FOUNDATION_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  describe("isHex", () => {
    it("recognizes valid hex addresses", () => {
      expect(AddressCodec.isHex(KNOWN_HEX)).toBe(true);
      expect(AddressCodec.isHex(FOUNDATION_HEX)).toBe(true);
    });

    it("recognizes 0x-prefixed hex addresses", () => {
      expect(AddressCodec.isHex("0x" + KNOWN_HEX)).toBe(true);
    });

    it("rejects non-hex addresses", () => {
      expect(AddressCodec.isHex(KNOWN_BASE58)).toBe(false);
      expect(AddressCodec.isHex("")).toBe(false);
      expect(AddressCodec.isHex("41short")).toBe(false);
    });
  });

  describe("isBase58", () => {
    it("recognizes valid Base58 addresses", () => {
      expect(AddressCodec.isBase58(KNOWN_BASE58)).toBe(true);
      expect(AddressCodec.isBase58(FOUNDATION_BASE58)).toBe(true);
    });

    it("rejects hex addresses", () => {
      expect(AddressCodec.isBase58(KNOWN_HEX)).toBe(false);
    });

    it("rejects empty and short strings", () => {
      expect(AddressCodec.isBase58("")).toBe(false);
      expect(AddressCodec.isBase58("T")).toBe(false);
    });
  });

  describe("hexToBase58", () => {
    it("converts known hex to Base58Check", () => {
      expect(AddressCodec.hexToBase58(KNOWN_HEX)).toBe(KNOWN_BASE58);
    });

    it("converts foundation address", () => {
      expect(AddressCodec.hexToBase58(FOUNDATION_HEX)).toBe(FOUNDATION_BASE58);
    });

    it("throws on invalid hex prefix", () => {
      expect(() => AddressCodec.hexToBase58("5000000000000000000000000000000000000000")).toThrow();
    });

    it("throws on wrong length", () => {
      expect(() => AddressCodec.hexToBase58("41abcd")).toThrow();
    });
  });

  describe("base58ToHex", () => {
    it("converts known Base58 back to hex", () => {
      expect(AddressCodec.base58ToHex(KNOWN_BASE58)).toBe(KNOWN_HEX);
    });

    it("round-trips with hexToBase58", () => {
      const base58 = AddressCodec.hexToBase58(FOUNDATION_HEX);
      const hex = AddressCodec.base58ToHex(base58);
      expect(hex).toBe(FOUNDATION_HEX);
    });

    it("throws on invalid checksum", () => {
      const mangled = KNOWN_BASE58.slice(0, -1) + (KNOWN_BASE58.endsWith("a") ? "b" : "a");
      expect(() => AddressCodec.base58ToHex(mangled)).toThrow("checksum");
    });
  });

  describe("toBase58", () => {
    it("passes through Base58 addresses", () => {
      expect(AddressCodec.toBase58(KNOWN_BASE58)).toBe(KNOWN_BASE58);
    });

    it("converts hex addresses", () => {
      expect(AddressCodec.toBase58(KNOWN_HEX)).toBe(KNOWN_BASE58);
    });

    it("throws on unrecognized format", () => {
      expect(() => AddressCodec.toBase58("not-an-address")).toThrow("Unrecognized");
    });
  });

  describe("toHex", () => {
    it("passes through hex addresses", () => {
      expect(AddressCodec.toHex(KNOWN_HEX)).toBe(KNOWN_HEX);
    });

    it("converts Base58 addresses", () => {
      expect(AddressCodec.toHex(KNOWN_BASE58)).toBe(KNOWN_HEX);
    });
  });

  describe("normalize", () => {
    it("normalizes hex to Base58", () => {
      expect(AddressCodec.normalize(KNOWN_HEX)).toBe(KNOWN_BASE58);
    });

    it("passes through Base58", () => {
      expect(AddressCodec.normalize(KNOWN_BASE58)).toBe(KNOWN_BASE58);
    });

    it("returns null for null/undefined", () => {
      expect(AddressCodec.normalize(null)).toBeNull();
      expect(AddressCodec.normalize(undefined)).toBeNull();
    });

    it("returns original on invalid address", () => {
      expect(AddressCodec.normalize("not-valid")).toBe("not-valid");
    });
  });
});

// ── AmountNormalizer ──

describe("AmountNormalizer", () => {
  describe("toSun", () => {
    it("passes through SUN values", () => {
      expect(AmountNormalizer.toSun("5000000", "SUN")).toBe("5000000");
    });

    it("converts TRX to SUN", () => {
      expect(AmountNormalizer.toSun("5", "TRX")).toBe("5000000");
    });

    it("converts fractional TRX to SUN", () => {
      expect(AmountNormalizer.toSun("1.5", "TRX")).toBe("1500000");
    });

    it("handles numeric input", () => {
      expect(AmountNormalizer.toSun(10, "TRX")).toBe("10000000");
    });
  });

  describe("toTrx", () => {
    it("converts whole SUN to TRX", () => {
      expect(AmountNormalizer.toTrx("5000000")).toBe("5");
    });

    it("converts fractional SUN to TRX", () => {
      expect(AmountNormalizer.toTrx("1500000")).toBe("1.5");
    });

    it("handles zero", () => {
      expect(AmountNormalizer.toTrx("0")).toBe("0");
    });

    it("handles sub-TRX amounts", () => {
      expect(AmountNormalizer.toTrx("100")).toBe("0.0001");
    });
  });

  describe("normalizeSun", () => {
    it("converts numbers to string", () => {
      expect(AmountNormalizer.normalizeSun(5000000)).toBe("5000000");
    });

    it("passes through string values", () => {
      expect(AmountNormalizer.normalizeSun("5000000")).toBe("5000000");
    });

    it("returns null for null/undefined", () => {
      expect(AmountNormalizer.normalizeSun(null)).toBeNull();
      expect(AmountNormalizer.normalizeSun(undefined)).toBeNull();
    });
  });
});

// ── ContractClassifier ──

describe("ContractClassifier", () => {
  describe("fromNumeric", () => {
    it("maps known contract types", () => {
      expect(ContractClassifier.fromNumeric(1)).toBe("TransferContract");
      expect(ContractClassifier.fromNumeric(2)).toBe("TransferAssetContract");
      expect(ContractClassifier.fromNumeric(4)).toBe("VoteWitnessContract");
      expect(ContractClassifier.fromNumeric(30)).toBe("TriggerSmartContract");
      expect(ContractClassifier.fromNumeric(54)).toBe("FreezeBalanceV2Contract");
      expect(ContractClassifier.fromNumeric(57)).toBe("DelegateResourceContract");
    });

    it("handles unknown types gracefully", () => {
      expect(ContractClassifier.fromNumeric(999)).toBe("ContractType_999");
    });
  });

  describe("normalize", () => {
    it("passes through string types", () => {
      expect(ContractClassifier.normalize("TransferContract")).toBe("TransferContract");
    });

    it("converts numeric to string", () => {
      expect(ContractClassifier.normalize(1)).toBe("TransferContract");
    });
  });

  describe("classification helpers", () => {
    it("identifies transfers", () => {
      expect(ContractClassifier.isTransfer("TransferContract")).toBe(true);
      expect(ContractClassifier.isTransfer("TransferAssetContract")).toBe(true);
      expect(ContractClassifier.isTransfer("TriggerSmartContract")).toBe(false);
    });

    it("identifies smart contract calls", () => {
      expect(ContractClassifier.isSmartContract("TriggerSmartContract")).toBe(true);
      expect(ContractClassifier.isSmartContract("CreateSmartContract")).toBe(true);
      expect(ContractClassifier.isSmartContract("TransferContract")).toBe(false);
    });

    it("identifies staking operations", () => {
      expect(ContractClassifier.isStaking("FreezeBalanceV2Contract")).toBe(true);
      expect(ContractClassifier.isStaking("UnfreezeBalanceV2Contract")).toBe(true);
      expect(ContractClassifier.isStaking("DelegateResourceContract")).toBe(true);
      expect(ContractClassifier.isStaking("TransferContract")).toBe(false);
    });

    it("identifies governance operations", () => {
      expect(ContractClassifier.isGovernance("VoteWitnessContract")).toBe(true);
      expect(ContractClassifier.isGovernance("ProposalCreateContract")).toBe(true);
      expect(ContractClassifier.isGovernance("TransferContract")).toBe(false);
    });
  });
});

// ── TimestampNormalizer ──

describe("TimestampNormalizer", () => {
  describe("toDate", () => {
    it("handles millisecond timestamps", () => {
      const date = TimestampNormalizer.toDate(1_700_000_000_000);
      expect(date.getFullYear()).toBe(2023);
    });

    it("handles second timestamps", () => {
      const date = TimestampNormalizer.toDate(1_700_000_000);
      expect(date.getFullYear()).toBe(2023);
    });

    it("produces the same Date from equivalent ms and s timestamps", () => {
      const fromMs = TimestampNormalizer.toDate(1_700_000_000_000);
      const fromS = TimestampNormalizer.toDate(1_700_000_000);
      expect(fromMs.getTime()).toBe(fromS.getTime());
    });
  });

  describe("toMillis", () => {
    it("passes through millisecond values", () => {
      expect(TimestampNormalizer.toMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
    });

    it("converts second values to milliseconds", () => {
      expect(TimestampNormalizer.toMillis(1_700_000_000)).toBe(1_700_000_000_000);
    });
  });
});

// ── PermissionParser ──

describe("PermissionParser", () => {
  it("parses owner permission", () => {
    const result = PermissionParser.parse({
      owner_permission: {
        type: 0,
        permission_name: "owner",
        threshold: 1,
        keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("owner");
    expect(result[0]!.threshold).toBe(1);
    expect(result[0]!.keys).toHaveLength(1);
    expect(result[0]!.keys[0]!.weight).toBe(1);
  });

  it("parses multi-sig permission", () => {
    const result = PermissionParser.parse({
      owner_permission: {
        type: 0,
        permission_name: "owner",
        threshold: 2,
        keys: [
          { address: "410000000000000000000000000000000000000000", weight: 1 },
          { address: "410000000000000000000000000000000000000001", weight: 1 },
          { address: "410000000000000000000000000000000000000002", weight: 1 },
        ],
      },
    });

    expect(result[0]!.threshold).toBe(2);
    expect(result[0]!.keys).toHaveLength(3);
  });

  it("parses active permissions with operations", () => {
    const result = PermissionParser.parse({
      active_permission: [
        {
          type: 2,
          permission_name: "active0",
          threshold: 1,
          keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
          operations: "7fff1fc0033e0000000000000000000000000000000000000000000000000000",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("active");
    expect(result[0]!.operations).toBeTruthy();
  });

  it("parses witness permission", () => {
    const result = PermissionParser.parse({
      witness_permission: {
        type: 1,
        permission_name: "witness",
        threshold: 1,
        keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("witness");
  });

  it("parses all permission types together", () => {
    const result = PermissionParser.parse({
      owner_permission: {
        type: 0,
        permission_name: "owner",
        threshold: 1,
        keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
      },
      witness_permission: {
        type: 1,
        permission_name: "witness",
        threshold: 1,
        keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
      },
      active_permission: [
        {
          type: 2,
          permission_name: "active0",
          threshold: 1,
          keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
        },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result.map((p) => p.type)).toEqual(["owner", "witness", "active"]);
  });

  it("normalizes hex addresses in keys to Base58", () => {
    const result = PermissionParser.parse({
      owner_permission: {
        type: 0,
        permission_name: "owner",
        threshold: 1,
        keys: [{ address: "410000000000000000000000000000000000000000", weight: 1 }],
      },
    });

    expect(result[0]!.keys[0]!.address).toMatch(/^T/);
  });

  it("handles empty permissions gracefully", () => {
    const result = PermissionParser.parse({});
    expect(result).toHaveLength(0);
  });
});
