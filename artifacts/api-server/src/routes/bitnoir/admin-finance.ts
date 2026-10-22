import {
  and,
  asc,
  desc,
  eq,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirAuditEventsTable,
  bitnoirBnbDepositsTable,
  bitnoirBnbLedgerTable,
  bitnoirBnbWithdrawalsTable,
  bitnoirFarmingTermsTable,
  bitnoirPlatformSettingsTable,
  bitnoirUsersTable,
  db,
} from "@workspace/db";
import {
  ApproveBnbDepositParams,
  ApproveBnbDepositResponse,
  GetAdminDepositsQueryParams,
  GetAdminDepositsResponse,
  GetAdminFarmingSettingsResponse,
  GetAdminSetupResponse,
  GetAdminWithdrawalsQueryParams,
  GetAdminWithdrawalsResponse,
  InitializeSuperAdminResponse,
  MarkBnbWithdrawalPaidBody,
  MarkBnbWithdrawalPaidParams,
  MarkBnbWithdrawalPaidResponse,
  RejectBnbDepositBody,
  RejectBnbDepositParams,
  RejectBnbDepositResponse,
  RejectBnbWithdrawalBody,
  RejectBnbWithdrawalParams,
  RejectBnbWithdrawalResponse,
  UpdateAdminFarmingSettingsBody,
  UpdateAdminFarmingSettingsResponse,
} from "@workspace/api-zod";
import {
  BNB_CHAIN_ID,
  BNB_MIN_CONFIRMATIONS,
  BnbVerificationError,
  getTreasuryAddress,
  verifyBscNativeTransfer,
} from "../../lib/finance";
import {
  requireSignedIn,
  requireSuperAdmin,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();
const allowedDurations = [15, 30, 45, 60] as const;

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
  username: string,
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
    username,
  };
}

function serializeWithdrawal(
  row: typeof bitnoirBnbWithdrawalsTable.$inferSelect,
  username: string,
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
    username,
  };
}

async function seedFarmingTerms(): Promise<void> {
  await db
    .insert(bitnoirFarmingTermsTable)
    .values(
      allowedDurations.map((durationDays) => ({
        durationDays,
        annualRateBps: null,
        enabled: false,
      })),
    )
    .onConflictDoNothing();
}

router.get(
  "/admin/setup",
  requireSignedIn,
  async (_req, res): Promise<void> => {
    await db
      .insert(bitnoirPlatformSettingsTable)
      .values({ id: 1 })
      .onConflictDoNothing();
    const [settings] = await db
      .select()
      .from(bitnoirPlatformSettingsTable)
      .where(eq(bitnoirPlatformSettingsTable.id, 1))
      .limit(1);
    if (!settings) {
      res.status(503).json({ error: "Platform setup is unavailable" });
      return;
    }
    const clerkUserId = res.locals.clerkUserId as string;
    const configuredId = process.env.BITNOIR_SUPER_ADMIN_CLERK_USER_ID?.trim();
    const [profile] = await db
      .select({ id: bitnoirUsersTable.id, suspended: bitnoirUsersTable.suspended })
      .from(bitnoirUsersTable)
      .where(eq(bitnoirUsersTable.clerkUserId, clerkUserId))
      .limit(1);
    res.json(
      GetAdminSetupResponse.parse({
        initialized: settings.superAdminUserId !== null,
        eligible:
          settings.superAdminUserId === null &&
          configuredId === clerkUserId &&
          Boolean(profile) &&
          !profile?.suspended,
        clerkUserId,
      }),
    );
  },
);

router.post(
  "/admin/initialize",
  requireSignedIn,
  async (_req, res): Promise<void> => {
    const clerkUserId = res.locals.clerkUserId as string;
    if (
      !process.env.BITNOIR_SUPER_ADMIN_CLERK_USER_ID ||
      process.env.BITNOIR_SUPER_ADMIN_CLERK_USER_ID.trim() !== clerkUserId
    ) {
      res.status(403).json({ error: "This account is not configured to initialize Super Admin" });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        await tx
          .insert(bitnoirPlatformSettingsTable)
          .values({ id: 1 })
          .onConflictDoNothing();
        const [settings] = await tx
          .select()
          .from(bitnoirPlatformSettingsTable)
          .where(eq(bitnoirPlatformSettingsTable.id, 1))
          .for("update");
        if (!settings) {
          throw new Error("PLATFORM_SETTINGS_UNAVAILABLE");
        }
        if (settings.superAdminUserId !== null) {
          throw new Error("SUPER_ADMIN_ALREADY_INITIALIZED");
        }
        const [profile] = await tx
          .select()
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.clerkUserId, clerkUserId))
          .for("update");
        if (!profile || profile.suspended) {
          throw new Error("ACTIVE_PROFILE_REQUIRED");
        }
        const [promoted] = await tx
          .update(bitnoirUsersTable)
          .set({ role: "super_admin" })
          .where(eq(bitnoirUsersTable.id, profile.id))
          .returning({ id: bitnoirUsersTable.id });
        if (!promoted) {
          throw new Error("ACTIVE_PROFILE_REQUIRED");
        }
        await tx
          .update(bitnoirPlatformSettingsTable)
          .set({ superAdminUserId: profile.id, initializedAt: new Date() })
          .where(eq(bitnoirPlatformSettingsTable.id, 1));
        await tx.insert(bitnoirAuditEventsTable).values({
          actorUserId: profile.id,
          action: "super_admin_initialized",
        });
      });
      res.json(
        InitializeSuperAdminResponse.parse({
          initialized: true,
          eligible: true,
          clerkUserId,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "SUPER_ADMIN_ALREADY_INITIALIZED"
      ) {
        res.status(409).json({ error: "Super Admin has already been initialized" });
        return;
      }
      if (error instanceof Error && error.message === "ACTIVE_PROFILE_REQUIRED") {
        res.status(403).json({ error: "An active Bitnoir profile is required" });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/admin/deposits",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = GetAdminDepositsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const rows = await db
      .select({
        deposit: bitnoirBnbDepositsTable,
        username: bitnoirUsersTable.username,
      })
      .from(bitnoirBnbDepositsTable)
      .innerJoin(
        bitnoirUsersTable,
        eq(bitnoirBnbDepositsTable.userId, bitnoirUsersTable.id),
      )
      .orderBy(desc(bitnoirBnbDepositsTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(
      GetAdminDepositsResponse.parse(
        rows.map(({ deposit, username }) => serializeDeposit(deposit, username)),
      ),
    );
  },
);

router.post(
  "/admin/deposits/:depositId/approve",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = ApproveBnbDepositParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid deposit identifier" });
      return;
    }
    const [current] = await db
      .select()
      .from(bitnoirBnbDepositsTable)
      .where(eq(bitnoirBnbDepositsTable.id, params.data.depositId))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Deposit not found" });
      return;
    }
    let verified;
    try {
      verified = await verifyBscNativeTransfer(current.txHash);
    } catch (error) {
      if (
        error instanceof BnbVerificationError &&
        (error.reason === "disabled" || error.reason === "unavailable")
      ) {
        res.status(503).json({ error: "BNB transaction verification is temporarily unavailable" });
        return;
      }
      res.status(409).json({ error: "Deposit transaction is no longer valid" });
      return;
    }
    const treasuryAddress = getTreasuryAddress();
    if (
      !treasuryAddress ||
      verified.to.toLowerCase() !== treasuryAddress.toLowerCase() ||
      verified.from.toLowerCase() !== current.senderAddress.toLowerCase() ||
      verified.valueWei.toString() !== current.amountWei ||
      verified.confirmations < BNB_MIN_CONFIRMATIONS
    ) {
      res.status(409).json({ error: "Deposit transaction does not match the recorded payment" });
      return;
    }

    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const username = await db.transaction(async (tx) => {
        const [deposit] = await tx
          .select()
          .from(bitnoirBnbDepositsTable)
          .where(eq(bitnoirBnbDepositsTable.id, current.id))
          .for("update");
        if (!deposit || deposit.status !== "pending") {
          throw new Error("DEPOSIT_NOT_PENDING");
        }
        const [user] = await tx
          .select({
            id: bitnoirUsersTable.id,
            username: bitnoirUsersTable.username,
            bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei,
          })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, deposit.userId))
          .for("update");
        if (!user) {
          throw new Error("DEPOSIT_USER_MISSING");
        }
        const [updatedUser] = await tx
          .update(bitnoirUsersTable)
          .set({
            bnbBalanceWei: sql`${bitnoirUsersTable.bnbBalanceWei} + ${deposit.amountWei}`,
          })
          .where(eq(bitnoirUsersTable.id, user.id))
          .returning({ bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei });
        if (!updatedUser) {
          throw new Error("DEPOSIT_CREDIT_FAILED");
        }
        const reviewedAt = new Date();
        const [approved] = await tx
          .update(bitnoirBnbDepositsTable)
          .set({
            status: "approved",
            confirmations: verified.confirmations,
            reviewedByUserId: actor.id,
            reviewedAt,
          })
          .where(eq(bitnoirBnbDepositsTable.id, deposit.id))
          .returning();
        if (!approved) {
          throw new Error("DEPOSIT_APPROVAL_FAILED");
        }
        await tx.insert(bitnoirBnbLedgerTable).values({
          userId: user.id,
          referenceId: deposit.id,
          kind: "deposit",
          amountWei: deposit.amountWei,
          balanceAfterWei: updatedUser.bnbBalanceWei,
          description: "Verified BNB deposit",
        });
        await tx.insert(bitnoirAuditEventsTable).values({
          actorUserId: actor.id,
          targetUserId: user.id,
          action: "bnb_deposit_approved",
        });
        return user.username;
      });
      const [approved] = await db
        .select()
        .from(bitnoirBnbDepositsTable)
        .where(eq(bitnoirBnbDepositsTable.id, current.id))
        .limit(1);
      if (!approved) {
        res.status(404).json({ error: "Deposit not found" });
        return;
      }
      res.json(
        ApproveBnbDepositResponse.parse(
          serializeDeposit(approved, username),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "DEPOSIT_NOT_PENDING") {
        res.status(409).json({ error: "Deposit is no longer pending" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/admin/deposits/:depositId/reject",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = RejectBnbDepositParams.safeParse(req.params);
    const body = RejectBnbDepositBody.safeParse(req.body);
    const note = body.success ? body.data.note.trim() : "";
    if (!params.success || !body.success || !note) {
      res.status(400).json({ error: "Provide a rejection reason" });
      return;
    }
    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const result = await db.transaction(async (tx) => {
        const [deposit] = await tx
          .select()
          .from(bitnoirBnbDepositsTable)
          .where(eq(bitnoirBnbDepositsTable.id, params.data.depositId))
          .for("update");
        if (!deposit) {
          throw new Error("DEPOSIT_NOT_FOUND");
        }
        if (deposit.status !== "pending") {
          throw new Error("DEPOSIT_NOT_PENDING");
        }
        const [updated] = await tx
          .update(bitnoirBnbDepositsTable)
          .set({
            status: "rejected",
            rejectionNote: note,
            reviewedByUserId: actor.id,
            reviewedAt: new Date(),
          })
          .where(eq(bitnoirBnbDepositsTable.id, deposit.id))
          .returning();
        if (!updated) {
          throw new Error("DEPOSIT_REJECT_FAILED");
        }
        await tx.insert(bitnoirAuditEventsTable).values({
          actorUserId: actor.id,
          targetUserId: deposit.userId,
          action: "bnb_deposit_rejected",
        });
        const [user] = await tx
          .select({ username: bitnoirUsersTable.username })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, deposit.userId))
          .limit(1);
        return { deposit: updated, username: user?.username ?? "unknown" };
      });
      res.json(
        RejectBnbDepositResponse.parse(
          serializeDeposit(result.deposit, result.username),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "DEPOSIT_NOT_FOUND") {
        res.status(404).json({ error: "Deposit not found" });
        return;
      }
      if (error instanceof Error && error.message === "DEPOSIT_NOT_PENDING") {
        res.status(409).json({ error: "Deposit is no longer pending" });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/admin/withdrawals",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = GetAdminWithdrawalsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const rows = await db
      .select({
        withdrawal: bitnoirBnbWithdrawalsTable,
        username: bitnoirUsersTable.username,
      })
      .from(bitnoirBnbWithdrawalsTable)
      .innerJoin(
        bitnoirUsersTable,
        eq(bitnoirBnbWithdrawalsTable.userId, bitnoirUsersTable.id),
      )
      .orderBy(desc(bitnoirBnbWithdrawalsTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(
      GetAdminWithdrawalsResponse.parse(
        rows.map(({ withdrawal, username }) =>
          serializeWithdrawal(withdrawal, username),
        ),
      ),
    );
  },
);

router.post(
  "/admin/withdrawals/:withdrawalId/mark-paid",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = MarkBnbWithdrawalPaidParams.safeParse(req.params);
    const body = MarkBnbWithdrawalPaidBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Provide a valid payment transaction hash" });
      return;
    }
    const [current] = await db
      .select()
      .from(bitnoirBnbWithdrawalsTable)
      .where(eq(bitnoirBnbWithdrawalsTable.id, params.data.withdrawalId))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Withdrawal not found" });
      return;
    }
    let verified;
    try {
      verified = await verifyBscNativeTransfer(body.data.txHash);
    } catch (error) {
      if (
        error instanceof BnbVerificationError &&
        (error.reason === "disabled" || error.reason === "unavailable")
      ) {
        res.status(503).json({ error: "BNB transaction verification is temporarily unavailable" });
        return;
      }
      res.status(409).json({ error: "Payment transaction is invalid" });
      return;
    }
    const treasuryAddress = getTreasuryAddress();
    if (
      !treasuryAddress ||
      verified.from.toLowerCase() !== treasuryAddress.toLowerCase() ||
      verified.to.toLowerCase() !== current.destinationAddress.toLowerCase() ||
      verified.valueWei.toString() !== current.payoutWei ||
      verified.confirmations < BNB_MIN_CONFIRMATIONS
    ) {
      res.status(409).json({ error: "Payment transaction does not match the withdrawal" });
      return;
    }
    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const username = await db.transaction(async (tx) => {
        const [withdrawal] = await tx
          .select()
          .from(bitnoirBnbWithdrawalsTable)
          .where(eq(bitnoirBnbWithdrawalsTable.id, current.id))
          .for("update");
        if (!withdrawal || withdrawal.status !== "pending") {
          throw new Error("WITHDRAWAL_NOT_PENDING");
        }
        const [updated] = await tx
          .update(bitnoirBnbWithdrawalsTable)
          .set({
            status: "paid",
            txHash: body.data.txHash.toLowerCase(),
            reviewedByUserId: actor.id,
            completedAt: new Date(),
          })
          .where(eq(bitnoirBnbWithdrawalsTable.id, withdrawal.id))
          .returning();
        if (!updated) {
          throw new Error("WITHDRAWAL_UPDATE_FAILED");
        }
        await tx.insert(bitnoirAuditEventsTable).values({
          actorUserId: actor.id,
          targetUserId: withdrawal.userId,
          action: "bnb_withdrawal_paid",
        });
        const [user] = await tx
          .select({ username: bitnoirUsersTable.username })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, withdrawal.userId))
          .limit(1);
        return user?.username ?? "unknown";
      });
      const [paid] = await db
        .select()
        .from(bitnoirBnbWithdrawalsTable)
        .where(eq(bitnoirBnbWithdrawalsTable.id, current.id))
        .limit(1);
      if (!paid) {
        res.status(404).json({ error: "Withdrawal not found" });
        return;
      }
      res.json(
        MarkBnbWithdrawalPaidResponse.parse(
          serializeWithdrawal(paid, username),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "WITHDRAWAL_NOT_PENDING") {
        res.status(409).json({ error: "Withdrawal is no longer pending" });
        return;
      }
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "Transaction hash was already recorded" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/admin/withdrawals/:withdrawalId/reject",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = RejectBnbWithdrawalParams.safeParse(req.params);
    const body = RejectBnbWithdrawalBody.safeParse(req.body);
    const note = body.success ? body.data.note.trim() : "";
    if (!params.success || !body.success || !note) {
      res.status(400).json({ error: "Provide a withdrawal rejection reason" });
      return;
    }
    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const result = await db.transaction(async (tx) => {
        const [withdrawal] = await tx
          .select()
          .from(bitnoirBnbWithdrawalsTable)
          .where(eq(bitnoirBnbWithdrawalsTable.id, params.data.withdrawalId))
          .for("update");
        if (!withdrawal) {
          throw new Error("WITHDRAWAL_NOT_FOUND");
        }
        if (withdrawal.status !== "pending") {
          throw new Error("WITHDRAWAL_NOT_PENDING");
        }
        const [user] = await tx
          .select()
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, withdrawal.userId))
          .for("update");
        if (!user) {
          throw new Error("WITHDRAWAL_USER_MISSING");
        }
        const [updatedUser] = await tx
          .update(bitnoirUsersTable)
          .set({
            bnbBalanceWei: sql`${bitnoirUsersTable.bnbBalanceWei} + ${withdrawal.amountWei}`,
          })
          .where(eq(bitnoirUsersTable.id, user.id))
          .returning({ bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei });
        if (!updatedUser) {
          throw new Error("WITHDRAWAL_REFUND_FAILED");
        }
        const [rejected] = await tx
          .update(bitnoirBnbWithdrawalsTable)
          .set({
            status: "rejected",
            rejectionNote: note,
            reviewedByUserId: actor.id,
            completedAt: new Date(),
          })
          .where(eq(bitnoirBnbWithdrawalsTable.id, withdrawal.id))
          .returning();
        if (!rejected) {
          throw new Error("WITHDRAWAL_UPDATE_FAILED");
        }
        await tx.insert(bitnoirBnbLedgerTable).values({
          userId: user.id,
          referenceId: withdrawal.id,
          kind: "withdrawal_reversal",
          amountWei: withdrawal.amountWei,
          balanceAfterWei: updatedUser.bnbBalanceWei,
          description: "Rejected BNB withdrawal released",
        });
        await tx.insert(bitnoirAuditEventsTable).values({
          actorUserId: actor.id,
          targetUserId: user.id,
          action: "bnb_withdrawal_rejected",
        });
        return { withdrawal: rejected, username: user.username };
      });
      res.json(
        RejectBnbWithdrawalResponse.parse(
          serializeWithdrawal(result.withdrawal, result.username),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "WITHDRAWAL_NOT_FOUND") {
        res.status(404).json({ error: "Withdrawal not found" });
        return;
      }
      if (error instanceof Error && error.message === "WITHDRAWAL_NOT_PENDING") {
        res.status(409).json({ error: "Withdrawal is no longer pending" });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/admin/farming/settings",
  requireSignedIn,
  requireSuperAdmin,
  async (_req, res): Promise<void> => {
    await seedFarmingTerms();
    const rows = await db
      .select({
        durationDays: bitnoirFarmingTermsTable.durationDays,
        annualRateBps: bitnoirFarmingTermsTable.annualRateBps,
        enabled: bitnoirFarmingTermsTable.enabled,
      })
      .from(bitnoirFarmingTermsTable)
      .orderBy(asc(bitnoirFarmingTermsTable.durationDays));
    res.json(GetAdminFarmingSettingsResponse.parse(rows));
  },
);

router.patch(
  "/admin/farming/settings",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpdateAdminFarmingSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid farming settings" });
      return;
    }
    const durations = parsed.data.terms.map((term) => term.durationDays);
    if (
      new Set(durations).size !== allowedDurations.length ||
      !allowedDurations.every((duration) => durations.includes(duration))
    ) {
      res.status(400).json({ error: "Configure each supported farming duration once" });
      return;
    }
    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    await seedFarmingTerms();
    const rows = await db.transaction(async (tx) => {
      const updatedAt = new Date();
      for (const term of parsed.data.terms) {
        await tx
          .insert(bitnoirFarmingTermsTable)
          .values({
            ...term,
            updatedByUserId: actor.id,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: bitnoirFarmingTermsTable.durationDays,
            set: {
              annualRateBps: term.annualRateBps,
              enabled: term.enabled,
              updatedByUserId: actor.id,
              updatedAt,
            },
          });
      }
      await tx.insert(bitnoirAuditEventsTable).values({
        actorUserId: actor.id,
        action: "farming_terms_updated",
      });
      return tx
        .select({
          durationDays: bitnoirFarmingTermsTable.durationDays,
          annualRateBps: bitnoirFarmingTermsTable.annualRateBps,
          enabled: bitnoirFarmingTermsTable.enabled,
        })
        .from(bitnoirFarmingTermsTable)
        .orderBy(asc(bitnoirFarmingTermsTable.durationDays));
    });
    res.json(UpdateAdminFarmingSettingsResponse.parse(rows));
  },
);

export default router;
