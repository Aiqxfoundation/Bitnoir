import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirBnbLedgerTable,
  bitnoirFarmPositionsTable,
  bitnoirFarmingTermsTable,
  bitnoirUsersTable,
  db,
} from "@workspace/db";
import {
  ClaimFarmPositionParams,
  ClaimFarmPositionResponse,
  CreateFarmPositionBody,
  CreateFarmPositionResponse,
  GetFarmingTermsResponse,
  GetMyFarmPositionsResponse,
} from "@workspace/api-zod";
import {
  calculateFarmRewardEstimateWei,
  parseBnbAmount,
} from "../../lib/finance";
import {
  requireActiveProfile,
  requireSignedIn,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();
const allowedDurations = [15, 30, 45, 60] as const;

async function ensureFarmingTerms(): Promise<void> {
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

function serializePosition(
  position: typeof bitnoirFarmPositionsTable.$inferSelect,
) {
  return {
    id: position.id,
    principalWei: position.principalWei,
    estimatedRewardWei: position.estimatedRewardWei,
    termDays: position.termDays,
    annualRateBps: position.annualRateBps,
    status: position.status,
    createdAt: position.createdAt,
    maturesAt: position.maturesAt,
    claimedAt: position.claimedAt,
  };
}

router.get("/farming/terms", async (_req, res): Promise<void> => {
  await ensureFarmingTerms();
  const rows = await db
    .select({
      durationDays: bitnoirFarmingTermsTable.durationDays,
      annualRateBps: bitnoirFarmingTermsTable.annualRateBps,
      enabled: bitnoirFarmingTermsTable.enabled,
    })
    .from(bitnoirFarmingTermsTable)
    .orderBy(asc(bitnoirFarmingTermsTable.durationDays));
  res.json(GetFarmingTermsResponse.parse(rows));
});

router.get(
  "/farming/positions",
  requireSignedIn,
  requireActiveProfile,
  async (_req, res): Promise<void> => {
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const rows = await db
      .select()
      .from(bitnoirFarmPositionsTable)
      .where(eq(bitnoirFarmPositionsTable.userId, profile.id))
      .orderBy(desc(bitnoirFarmPositionsTable.createdAt));
    res.json(
      GetMyFarmPositionsResponse.parse(rows.map(serializePosition)),
    );
  },
);

router.post(
  "/farming/positions",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = CreateFarmPositionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid farming position request" });
      return;
    }
    const principalWei = parseBnbAmount(parsed.data.amountBnb);
    if (principalWei === null || principalWei <= 0n) {
      res.status(400).json({ error: "Farming amount must be greater than zero" });
      return;
    }
    if (!allowedDurations.includes(parsed.data.termDays as (typeof allowedDurations)[number])) {
      res.status(400).json({ error: "Select a supported farming duration" });
      return;
    }

    await ensureFarmingTerms();
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const position = await db.transaction(async (tx) => {
        const [term] = await tx
          .select()
          .from(bitnoirFarmingTermsTable)
          .where(eq(bitnoirFarmingTermsTable.durationDays, parsed.data.termDays))
          .for("update");
        if (!term?.enabled || term.annualRateBps === null) {
          throw new Error("TERM_DISABLED");
        }
        const [user] = await tx
          .select({
            id: bitnoirUsersTable.id,
            bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei,
            suspended: bitnoirUsersTable.suspended,
          })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, profile.id))
          .for("update");
        if (!user || user.suspended) {
          throw new Error("ACCOUNT_INACTIVE");
        }
        if (BigInt(user.bnbBalanceWei) < principalWei) {
          throw new Error("INSUFFICIENT_BNB");
        }

        const [updatedUser] = await tx
          .update(bitnoirUsersTable)
          .set({
            bnbBalanceWei: sql`${bitnoirUsersTable.bnbBalanceWei} - ${principalWei.toString()}`,
          })
          .where(
            and(
              eq(bitnoirUsersTable.id, profile.id),
              gte(bitnoirUsersTable.bnbBalanceWei, principalWei.toString()),
            ),
          )
          .returning({ bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei });
        if (!updatedUser) {
          throw new Error("INSUFFICIENT_BNB");
        }

        const termDays = parsed.data.termDays;
        const estimatedRewardWei = calculateFarmRewardEstimateWei(
          principalWei,
          term.annualRateBps,
          termDays,
        );
        const createdAt = new Date();
        const maturesAt = new Date(
          createdAt.getTime() + termDays * 24 * 60 * 60 * 1000,
        );
        const [created] = await tx
          .insert(bitnoirFarmPositionsTable)
          .values({
            userId: profile.id,
            principalWei: principalWei.toString(),
            estimatedRewardWei: estimatedRewardWei.toString(),
            termDays,
            annualRateBps: term.annualRateBps,
            createdAt,
            maturesAt,
          })
          .returning();
        if (!created) {
          throw new Error("FARM_POSITION_CREATE_FAILED");
        }
        await tx.insert(bitnoirBnbLedgerTable).values({
          userId: profile.id,
          referenceId: created.id,
          kind: "farm_lock",
          amountWei: `-${principalWei.toString()}`,
          balanceAfterWei: updatedUser.bnbBalanceWei,
          description: `${termDays}-day BNB farming position started`,
        });
        return created;
      });
      res.status(201).json(
        CreateFarmPositionResponse.parse(serializePosition(position)),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "TERM_DISABLED") {
        res.status(409).json({ error: "That farming term is not currently available" });
        return;
      }
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

router.post(
  "/farming/positions/:farmId/claim",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = ClaimFarmPositionParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid farming position" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    try {
      const position = await db.transaction(async (tx) => {
        const [lockedPosition] = await tx
          .select()
          .from(bitnoirFarmPositionsTable)
          .where(
            and(
              eq(bitnoirFarmPositionsTable.id, parsed.data.farmId),
              eq(bitnoirFarmPositionsTable.userId, profile.id),
            ),
          )
          .for("update");
        if (!lockedPosition) {
          throw new Error("POSITION_NOT_FOUND");
        }
        if (
          lockedPosition.status !== "active" ||
          lockedPosition.maturesAt.getTime() > Date.now()
        ) {
          throw new Error("POSITION_NOT_CLAIMABLE");
        }

        const [user] = await tx
          .select({
            id: bitnoirUsersTable.id,
            bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei,
            suspended: bitnoirUsersTable.suspended,
          })
          .from(bitnoirUsersTable)
          .where(eq(bitnoirUsersTable.id, profile.id))
          .for("update");
        if (!user || user.suspended) {
          throw new Error("ACCOUNT_INACTIVE");
        }

        const creditWei = BigInt(lockedPosition.principalWei);
        const [updatedUser] = await tx
          .update(bitnoirUsersTable)
          .set({
            bnbBalanceWei: sql`${bitnoirUsersTable.bnbBalanceWei} + ${creditWei.toString()}`,
          })
          .where(eq(bitnoirUsersTable.id, profile.id))
          .returning({ bnbBalanceWei: bitnoirUsersTable.bnbBalanceWei });
        if (!updatedUser) {
          throw new Error("ACCOUNT_INACTIVE");
        }
        const claimedAt = new Date();
        const [claimed] = await tx
          .update(bitnoirFarmPositionsTable)
          .set({ status: "claimed", claimedAt })
          .where(
            and(
              eq(bitnoirFarmPositionsTable.id, lockedPosition.id),
              eq(bitnoirFarmPositionsTable.status, "active"),
              lte(bitnoirFarmPositionsTable.maturesAt, claimedAt),
            ),
          )
          .returning();
        if (!claimed) {
          throw new Error("POSITION_NOT_CLAIMABLE");
        }
        await tx.insert(bitnoirBnbLedgerTable).values({
          userId: profile.id,
          referenceId: claimed.id,
          kind: "farm_claim",
          amountWei: creditWei.toString(),
          balanceAfterWei: updatedUser.bnbBalanceWei,
          description: `${claimed.termDays}-day BNB position principal returned`,
        });
        return claimed;
      });
      res.json(ClaimFarmPositionResponse.parse(serializePosition(position)));
    } catch (error) {
      if (error instanceof Error && error.message === "POSITION_NOT_FOUND") {
        res.status(404).json({ error: "Farming position not found" });
        return;
      }
      if (error instanceof Error && error.message === "POSITION_NOT_CLAIMABLE") {
        res.status(409).json({ error: "Position has not matured or was already claimed" });
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
