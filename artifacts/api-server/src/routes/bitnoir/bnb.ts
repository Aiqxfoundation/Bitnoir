import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAddress, isAddress } from "viem";
import {
  bitnoirBnbDepositsTable,
  bitnoirBnbLedgerTable,
  bitnoirBnbWithdrawalsTable,
  bitnoirUsersTable,
  bitnoirWalletsTable,
  db,
} from "@workspace/db";
import {
  CreateBnbDepositBody,
  CreateBnbDepositResponse,
  CreateBnbWithdrawalBody,
  CreateBnbWithdrawalResponse,
  GetMyDepositsQueryParams,
  GetMyDepositsResponse,
  GetMyWithdrawalsQueryParams,
  GetMyWithdrawalsResponse,
} from "@workspace/api-zod";
import {
  areBnbOperationsEnabled,
  BNB_CHAIN_ID,
  BNB_MIN_CONFIRMATIONS,
  BnbVerificationError,
  calculateWithdrawalAmounts,
  getWithdrawalFeeBps,
  getTreasuryAddress,
  parseBnbAmount,
  verifyBscNativeTransfer,
} from "../../lib/finance";
import {
  requireActiveProfile,
  requireSignedIn,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function serializeDeposit(
  row: typeof bitnoirBnbDepositsTable.$inferSelect,
) {
  return {
    id: row.id,
    txHash: row.txHash,
    senderAddress: row.senderAddress,
    amountWei: row.amountWei,
    confirmations: row.confirmations,
    status: row.status,
    rejectionNote: row.rejectionNote,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  };
}

function serializeWithdrawal(
  row: typeof bitnoirBnbWithdrawalsTable.$inferSelect,
) {
  return {
    id: row.id,
    amountWei: row.amountWei,
    feeWei: row.feeWei,
    payoutWei: row.payoutWei,
    destinationAddress: row.destinationAddress,
    status: row.status,
    txHash: row.txHash,
    rejectionNote: row.rejectionNote,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

router.get(
  "/bnb/deposits",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = GetMyDepositsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const rows = await db
      .select()
      .from(bitnoirBnbDepositsTable)
      .where(eq(bitnoirBnbDepositsTable.userId, profile.id))
      .orderBy(desc(bitnoirBnbDepositsTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(GetMyDepositsResponse.parse(rows.map(serializeDeposit)));
  },
);

router.post(
  "/bnb/deposits",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = CreateBnbDepositBody.safeParse(req.body);
    if (!parsed.success || parsed.data.chainId !== BNB_CHAIN_ID) {
      res.status(400).json({ error: "Submit a valid BNB Smart Chain transaction hash" });
      return;
    }
    if (!areBnbOperationsEnabled()) {
      res.status(503).json({ error: "BNB deposit verification is not configured" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    let verified;
    try {
      verified = await verifyBscNativeTransfer(parsed.data.txHash);
    } catch (error) {
      if (
        error instanceof BnbVerificationError &&
        (error.reason === "disabled" || error.reason === "unavailable")
      ) {
        res.status(503).json({ error: "BNB transaction verification is temporarily unavailable" });
        return;
      }
      res.status(400).json({ error: "Transaction is invalid or not confirmed on BNB Smart Chain" });
      return;
    }
    const treasuryAddress = getTreasuryAddress();
    if (
      !treasuryAddress ||
      verified.to.toLowerCase() !== treasuryAddress.toLowerCase() ||
      verified.valueWei <= 0n
    ) {
      res.status(400).json({ error: "Transaction does not match the configured deposit address" });
      return;
    }
    if (verified.confirmations < BNB_MIN_CONFIRMATIONS) {
      res.status(400).json({ error: `Transaction needs at least ${BNB_MIN_CONFIRMATIONS} confirmations` });
      return;
    }
    const [wallet] = await db
      .select({ id: bitnoirWalletsTable.id })
      .from(bitnoirWalletsTable)
      .where(
        and(
          eq(bitnoirWalletsTable.userId, profile.id),
          eq(bitnoirWalletsTable.chainId, BNB_CHAIN_ID),
          sql`lower(${bitnoirWalletsTable.address}) = ${verified.from.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (!wallet) {
      res.status(400).json({ error: "Verify the sending wallet on your Bitnoir account first" });
      return;
    }

    try {
      const [created] = await db
        .insert(bitnoirBnbDepositsTable)
        .values({
          userId: profile.id,
          txHash: parsed.data.txHash.toLowerCase(),
          senderAddress: verified.from,
          amountWei: verified.valueWei.toString(),
          chainId: BNB_CHAIN_ID,
          confirmations: verified.confirmations,
        })
        .returning();
      if (!created) {
        throw new Error("DEPOSIT_CREATE_FAILED");
      }
      res.status(201).json(
        CreateBnbDepositResponse.parse(serializeDeposit(created)),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "Transaction hash was already submitted" });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/bnb/withdrawals",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = GetMyWithdrawalsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const rows = await db
      .select()
      .from(bitnoirBnbWithdrawalsTable)
      .where(eq(bitnoirBnbWithdrawalsTable.userId, profile.id))
      .orderBy(desc(bitnoirBnbWithdrawalsTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(GetMyWithdrawalsResponse.parse(rows.map(serializeWithdrawal)));
  },
);

router.post(
  "/bnb/withdrawals",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = CreateBnbWithdrawalBody.safeParse(req.body);
    if (!parsed.success || !isAddress(parsed.data.destinationAddress)) {
      res.status(400).json({ error: "Enter a valid BNB Smart Chain withdrawal request" });
      return;
    }
    const amountWei = parseBnbAmount(parsed.data.amountBnb);
    if (amountWei === null || amountWei <= 0n) {
      res.status(400).json({ error: "Withdrawal amount must be greater than zero" });
      return;
    }
    let destinationAddress: string;
    try {
      destinationAddress = getAddress(parsed.data.destinationAddress);
    } catch {
      res.status(400).json({ error: "Enter a valid destination wallet address" });
      return;
    }

    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const [wallet] = await db
      .select({ id: bitnoirWalletsTable.id })
      .from(bitnoirWalletsTable)
      .where(
        and(
          eq(bitnoirWalletsTable.userId, profile.id),
          eq(bitnoirWalletsTable.chainId, BNB_CHAIN_ID),
          sql`lower(${bitnoirWalletsTable.address}) = ${destinationAddress.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (!wallet) {
      res.status(400).json({ error: "Withdrawal destination must be a wallet verified on your account" });
      return;
    }

    let amounts: ReturnType<typeof calculateWithdrawalAmounts>;
    try {
      amounts = calculateWithdrawalAmounts(
        amountWei,
        getWithdrawalFeeBps(),
      );
    } catch {
      res.status(400).json({ error: "Withdrawal amount is too small after the fee" });
      return;
    }

    try {
      const withdrawal = await db.transaction(async (tx) => {
        const [lockedUser] = await tx
          .select({
            id: bitnoirUsersTable.id,
            username: bitnoirUsersTable.username,
            bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei,
            suspended: bitnoirUsersTable.suspended,
          })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, profile.id))
          .for("update");
        if (!lockedUser || lockedUser.suspended) {
          throw new Error("ACCOUNT_INACTIVE");
        }
        if (BigInt(lockedUser.bnbBalanceWei) < amountWei) {
          throw new Error("INSUFFICIENT_BNB");
        }

        const [updatedUser] = await tx
          .update(bitnoirUsersTable)
          .set({
            bnbBalanceWei: sql`${bitnoirUsersTable.bnbBalanceWei} - ${amountWei.toString()}`,
          })
          .where(
            and(
              eq(bitnoirUsersTable.id, profile.id),
              gte(bitnoirUsersTable.bnbBalanceWei, amountWei.toString()),
            ),
          )
          .returning({ bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei });
        if (!updatedUser) {
          throw new Error("INSUFFICIENT_BNB");
        }
        const [created] = await tx
          .insert(bitnoirBnbWithdrawalsTable)
          .values({
            userId: profile.id,
            amountWei: amounts.amountWei.toString(),
            feeWei: amounts.feeWei.toString(),
            payoutWei: amounts.payoutWei.toString(),
            destinationAddress,
          })
          .returning();
        if (!created) {
          throw new Error("WITHDRAWAL_CREATE_FAILED");
        }
        await tx.insert(bitnoirBnbLedgerTable).values({
          userId: profile.id,
          referenceId: created.id,
          kind: "withdrawal_request",
          amountWei: `-${amountWei.toString()}`,
          balanceAfterWei: updatedUser.bnbBalanceWei,
          description: "BNB withdrawal reserved",
        });
        return created;
      });
      res.status(201).json(
        CreateBnbWithdrawalResponse.parse(serializeWithdrawal(withdrawal)),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "INSUFFICIENT_BNB") {
        res.status(409).json({ error: "Insufficient available BNB balance" });
        return;
      }
      if (error instanceof Error && error.message === "ACCOUNT_INACTIVE") {
        res.status(403).json({ error: "This account is suspended" });
        return;
      }
      throw error;
    }
  },
);

export default router;
