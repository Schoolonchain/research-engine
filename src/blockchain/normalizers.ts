import { createHash } from "node:crypto";
import { BlockchainValidationError } from "./errors.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, bigint>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  ALPHABET_MAP.set(BASE58_ALPHABET[i]!, BigInt(i));
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let encoded = "";
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = BASE58_ALPHABET[Number(remainder)]! + encoded;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }

  return encoded;
}

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const val = ALPHABET_MAP.get(char);
    if (val === undefined) {
      throw new BlockchainValidationError(`Invalid Base58 character: ${char}`);
    }
    num = num * 58n + val;
  }

  const hex = num.toString(16);
  const paddedHex = hex.length % 2 === 1 ? "0" + hex : hex;
  const rawBytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < paddedHex.length; i += 2) {
    rawBytes[i / 2] = parseInt(paddedHex.substring(i, i + 2), 16);
  }

  let leadingZeros = 0;
  for (const char of str) {
    if (char !== "1") break;
    leadingZeros++;
  }

  const result = new Uint8Array(leadingZeros + rawBytes.length);
  result.set(rawBytes, leadingZeros);
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new BlockchainValidationError(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class AddressCodec {
  static isHex(address: string): boolean {
    return /^(41|0x41)[0-9a-fA-F]{40}$/i.test(address);
  }

  static isBase58(address: string): boolean {
    if (!address.startsWith("T")) return false;
    if (address.length < 25 || address.length > 36) return false;
    for (const char of address) {
      if (!ALPHABET_MAP.has(char) && char !== "1") return false;
    }
    return true;
  }

  static hexToBase58(hex: string): string {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^41[0-9a-fA-F]{40}$/i.test(clean)) {
      throw new BlockchainValidationError(
        `Invalid TRON hex address: must start with 41 and be 42 hex chars`,
      );
    }

    const addressBytes = hexToBytes(clean);
    const hash1 = sha256(addressBytes);
    const hash2 = sha256(hash1);
    const checksum = hash2.slice(0, 4);

    const payload = new Uint8Array(addressBytes.length + 4);
    payload.set(addressBytes);
    payload.set(checksum, addressBytes.length);

    return base58Encode(payload);
  }

  static base58ToHex(address: string): string {
    if (!AddressCodec.isBase58(address)) {
      throw new BlockchainValidationError(`Invalid TRON Base58 address: ${address}`);
    }

    const decoded = base58Decode(address);
    if (decoded.length < 5) {
      throw new BlockchainValidationError(`Base58 address too short after decoding`);
    }

    const payload = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);

    const hash1 = sha256(payload);
    const hash2 = sha256(hash1);
    const expectedChecksum = hash2.slice(0, 4);

    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== expectedChecksum[i]) {
        throw new BlockchainValidationError(`Base58Check checksum mismatch for address`);
      }
    }

    return bytesToHex(payload);
  }

  static toBase58(address: string): string {
    if (AddressCodec.isBase58(address)) return address;
    if (AddressCodec.isHex(address)) return AddressCodec.hexToBase58(address);
    throw new BlockchainValidationError(`Unrecognized TRON address format: ${address}`);
  }

  static toHex(address: string): string {
    if (AddressCodec.isHex(address)) {
      const clean = address.startsWith("0x") ? address.slice(2) : address;
      return clean.toLowerCase();
    }
    if (AddressCodec.isBase58(address)) return AddressCodec.base58ToHex(address);
    throw new BlockchainValidationError(`Unrecognized TRON address format: ${address}`);
  }

  static normalize(address: string | null | undefined): string | null {
    if (!address) return null;
    try {
      return AddressCodec.toBase58(address);
    } catch {
      return address;
    }
  }
}

const SUN_PER_TRX = 1_000_000n;

export class AmountNormalizer {
  static toSun(value: string | number, unit: "SUN" | "TRX"): string {
    if (unit === "SUN") return String(value);
    const decimal = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(decimal)) {
      throw new BlockchainValidationError(`Invalid amount: ${value}`);
    }
    return String(BigInt(Math.round(decimal * Number(SUN_PER_TRX))));
  }

  static toTrx(sunValue: string | number): string {
    const sun = BigInt(typeof sunValue === "number" ? Math.round(sunValue) : sunValue);
    const whole = sun / SUN_PER_TRX;
    const remainder = sun % SUN_PER_TRX;
    if (remainder === 0n) return whole.toString();
    const fractional = remainder.toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole}.${fractional}`;
  }

  static normalizeSun(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return String(typeof value === "number" ? Math.round(value) : value);
  }
}

const FULL_CONTRACT_TYPES: Readonly<Record<number, string>> = {
  0: "AccountCreateContract",
  1: "TransferContract",
  2: "TransferAssetContract",
  3: "VoteAssetContract",
  4: "VoteWitnessContract",
  5: "WitnessCreateContract",
  6: "AssetIssueContract",
  8: "AccountUpdateContract",
  9: "FreezeBalanceContract",
  10: "UnfreezeBalanceContract",
  11: "WithdrawBalanceContract",
  12: "UnfreezeAssetContract",
  13: "UpdateAssetContract",
  14: "ProposalCreateContract",
  15: "ProposalApproveContract",
  16: "ProposalDeleteContract",
  17: "SetAccountIdContract",
  18: "CustomContract",
  20: "CreateSmartContract",
  30: "TriggerSmartContract",
  31: "GetContract",
  32: "UpdateSettingContract",
  33: "ExchangeCreateContract",
  34: "ExchangeInjectContract",
  35: "ExchangeWithdrawContract",
  36: "ExchangeTransactionContract",
  41: "AccountPermissionUpdateContract",
  42: "ClearABIContract",
  43: "UpdateBrokerageContract",
  44: "ShieldedTransferContract",
  45: "MarketSellAssetContract",
  46: "MarketCancelOrderContract",
  48: "UpdateEnergyLimitContract",
  54: "FreezeBalanceV2Contract",
  55: "UnfreezeBalanceV2Contract",
  56: "WithdrawExpireUnfreezeContract",
  57: "DelegateResourceContract",
  58: "UnDelegateResourceContract",
  59: "CancelAllUnfreezeV2Contract",
};

export class ContractClassifier {
  static fromNumeric(type: number): string {
    return FULL_CONTRACT_TYPES[type] ?? `ContractType_${type}`;
  }

  static normalize(type: string | number): string {
    if (typeof type === "number") return ContractClassifier.fromNumeric(type);
    return type;
  }

  static isTransfer(type: string): boolean {
    return type === "TransferContract" || type === "TransferAssetContract";
  }

  static isSmartContract(type: string): boolean {
    return type === "TriggerSmartContract" || type === "CreateSmartContract";
  }

  static isStaking(type: string): boolean {
    return (
      type === "FreezeBalanceContract" ||
      type === "UnfreezeBalanceContract" ||
      type === "FreezeBalanceV2Contract" ||
      type === "UnfreezeBalanceV2Contract" ||
      type === "WithdrawExpireUnfreezeContract" ||
      type === "DelegateResourceContract" ||
      type === "UnDelegateResourceContract" ||
      type === "CancelAllUnfreezeV2Contract"
    );
  }

  static isGovernance(type: string): boolean {
    return (
      type === "VoteWitnessContract" ||
      type === "WitnessCreateContract" ||
      type === "ProposalCreateContract" ||
      type === "ProposalApproveContract" ||
      type === "ProposalDeleteContract"
    );
  }
}

const MILLIS_THRESHOLD = 1_000_000_000_000;

export class TimestampNormalizer {
  static toDate(timestamp: number): Date {
    if (timestamp > MILLIS_THRESHOLD) {
      return new Date(timestamp);
    }
    return new Date(timestamp * 1000);
  }

  static toMillis(timestamp: number): number {
    if (timestamp > MILLIS_THRESHOLD) return timestamp;
    return timestamp * 1000;
  }
}

export interface AccountPermission {
  readonly type: "owner" | "active" | "witness";
  readonly permissionName: string;
  readonly threshold: number;
  readonly keys: readonly {
    readonly address: string;
    readonly weight: number;
  }[];
  readonly operations: string | null;
}

interface RawPermissionKey {
  readonly address?: string;
  readonly weight?: number;
}

interface RawPermission {
  readonly type?: string | number;
  readonly permission_name?: string;
  readonly threshold?: number;
  readonly keys?: readonly RawPermissionKey[];
  readonly operations?: string;
}

function permissionType(raw: string | number | undefined): "owner" | "active" | "witness" {
  if (raw === 0 || raw === "owner" || raw === undefined) return "owner";
  if (raw === 1 || raw === "witness") return "witness";
  return "active";
}

export class PermissionParser {
  static parse(rawPermissions: {
    readonly owner_permission?: RawPermission;
    readonly active_permission?: readonly RawPermission[];
    readonly witness_permission?: RawPermission;
  }): readonly AccountPermission[] {
    const results: AccountPermission[] = [];

    if (rawPermissions.owner_permission) {
      results.push(PermissionParser.parseOne(rawPermissions.owner_permission, "owner"));
    }

    if (rawPermissions.witness_permission) {
      results.push(PermissionParser.parseOne(rawPermissions.witness_permission, "witness"));
    }

    if (rawPermissions.active_permission) {
      for (const perm of rawPermissions.active_permission) {
        results.push(PermissionParser.parseOne(perm, "active"));
      }
    }

    return Object.freeze(results);
  }

  private static parseOne(
    raw: RawPermission,
    fallbackType: "owner" | "active" | "witness",
  ): AccountPermission {
    const keys = (raw.keys ?? []).map((k) =>
      Object.freeze({
        address: AddressCodec.normalize(k.address) ?? "",
        weight: k.weight ?? 1,
      }),
    );

    return Object.freeze({
      type: permissionType(raw.type) ?? fallbackType,
      permissionName: raw.permission_name ?? fallbackType,
      threshold: raw.threshold ?? 1,
      keys: Object.freeze(keys),
      operations: raw.operations ?? null,
    });
  }
}
