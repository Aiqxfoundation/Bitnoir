import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

export const BNB_CHAIN_ID = 56;
export const BNB_MIN_CONFIRMATIONS = 6;
export const DEFAULT_WITHDRAWAL_FEE_BPS = 200;
export const MAX_WITHDRAWAL_FEE_BPS = 2500;

export type VerifiedNativeTransfer = {
  from: string;
  to: string;
  valueWei: bigint;
  confirmations: number;
};

export class BnbVerificationError extends Error {
  readonly reason:
    | "disabled"
    | "unavailable"
    | "not_found"
    | "failed"
    | "wrong_chain";

  constructor(
    reason:
      | "disabled"
      | "unavailable"
      | "not_found"
      | "failed"
      | "wrong_chain",
  ) {
    super(reason);
    this.reason = reason;
  }
}

export function getTreasuryAddress(): string | null {
  const configured = process.env.BITNOIR_TREASURY_ADDRESS?.trim();
  if (!configured || !isAddress(configured)) {
    return null;
  }
  try {
    return getAddress(configured);
  } catch {
    return null;
  }
}

function getBscClient() {
  const rpcUrl = process.env.BITNOIR_BSC_RPC_URL?.trim();
  if (!rpcUrl || !getTreasuryAddress()) {
    return null;
  }
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return createPublicClient({
    chain: bsc,
    transport: http(rpcUrl, { timeout: 12_000 }),
  });
}

export function areBnbOperationsEnabled(): boolean {
  return getBscClient() !== null;
}

export function getWithdrawalFeeBps(): number {
  const configured = process.env.BITNOIR_WITHDRAWAL_FEE_BPS?.trim();
  if (!configured) {
    return DEFAULT_WITHDRAWAL_FEE_BPS;
  }
  if (!/^\d+$/.test(configured)) {
    throw new Error("BITNOIR_WITHDRAWAL_FEE_BPS must be an integer");
  }
  const feeBps = Number(configured);
  if (!Number.isSafeInteger(feeBps) || feeBps > MAX_WITHDRAWAL_FEE_BPS) {
    throw new Error(
      `BITNOIR_WITHDRAWAL_FEE_BPS must be between 0 and ${MAX_WITHDRAWAL_FEE_BPS}`,
    );
  }
  return feeBps;
}

export function parseBnbAmount(amount: string): bigint | null {
  if (!/^[0-9]+(?:\.[0-9]{1,18})?$/.test(amount)) {
    return null;
  }
  try {
    return parseEther(amount);
  } catch {
    return null;
  }
}

export function calculateWithdrawalAmounts(
  amountWei: bigint,
  feeBps = DEFAULT_WITHDRAWAL_FEE_BPS,
): {
  amountWei: bigint;
  feeWei: bigint;
  payoutWei: bigint;
} {
  if (amountWei <= 0n) {
    throw new RangeError("Withdrawal amount must be greater than zero");
  }
  if (
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > MAX_WITHDRAWAL_FEE_BPS
  ) {
    throw new RangeError(
      `Withdrawal fee must be between 0 and ${MAX_WITHDRAWAL_FEE_BPS} bps`,
    );
  }
  const feeWei = (amountWei * BigInt(feeBps)) / 10_000n;
  const payoutWei = amountWei - feeWei;
  if (payoutWei <= 0n) {
    throw new RangeError("Withdrawal payout must be greater than zero");
  }
  return { amountWei, feeWei, payoutWei };
}

export function calculateFarmRewardEstimateWei(
  principalWei: bigint,
  annualRateBps: number,
  durationDays: number,
): bigint {
  if (principalWei <= 0n) {
    throw new RangeError("Farm principal must be greater than zero");
  }
  if (
    !Number.isInteger(annualRateBps) ||
    annualRateBps < 0 ||
    annualRateBps > 10_000
  ) {
    throw new RangeError("Annual rate must be between 0 and 10,000 bps");
  }
  if (![15, 30, 45, 60].includes(durationDays)) {
    throw new RangeError("Unsupported farming duration");
  }
  return (
    (principalWei * BigInt(annualRateBps) * BigInt(durationDays)) /
    (10_000n * 365n)
  );
}

export async function verifyBscNativeTransfer(
  txHash: string,
): Promise<VerifiedNativeTransfer> {
  const client = getBscClient();
  if (!client) {
    throw new BnbVerificationError("disabled");
  }
  try {
    const [chainId, transaction, receipt] = await Promise.all([
      client.getChainId(),
      client.getTransaction({ hash: txHash as Hex }),
      client.getTransactionReceipt({ hash: txHash as Hex }),
    ]);
    if (chainId !== BNB_CHAIN_ID) {
      throw new BnbVerificationError("wrong_chain");
    }
    if (transaction.hash.toLowerCase() !== txHash.toLowerCase()) {
      throw new BnbVerificationError("not_found");
    }
    if (receipt.status !== "success") {
      throw new BnbVerificationError("failed");
    }
    const latestBlock = await client.getBlockNumber();
    const confirmations = Number(latestBlock - receipt.blockNumber + 1n);
    if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
      throw new BnbVerificationError("unavailable");
    }
    if (!transaction.to) {
      throw new BnbVerificationError("failed");
    }
    return {
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      valueWei: transaction.value,
      confirmations,
    };
  } catch (error) {
    if (error instanceof BnbVerificationError) {
      throw error;
    }
    throw new BnbVerificationError("unavailable");
  }
}
