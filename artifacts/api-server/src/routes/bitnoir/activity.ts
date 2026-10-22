import { and, count, desc, eq, gt, lte, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirBnbDepositsTable,
  bitnoirBnbWithdrawalsTable,
  bitnoirFarmPositionsTable,
  bitnoirUsersTable,
  bitsLedgerTable,
  db,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetMyReferralsResponse,
} from "@workspace/api-zod";
import {
  requireActiveProfile,
  requireSignedIn,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();

async function referralRewardTotal(userId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${bitsLedgerTable.amount}), 0)::int`,
    })
    .from(bitsLedgerTable)
    .where(
      and(
        eq(bitsLedgerTable.userId, userId),
        eq(bitsLedgerTable.kind, "referral"),
      ),
    );
  return row?.total ?? 0;
}

router.get(
  "/dashboard",
  requireSignedIn,
  requireActiveProfile,
  async (_req, res): Promise<void> => {
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const now = new Date();
    const [
      [referralCount],
      [pendingDeposits],
      [pendingWithdrawals],
      [activeFarms],
      [matureFarms],
      referralBitsEarned,
    ] = await Promise.all([
      db
        .select({ total: count() })
        .from(bitnoirUsersTable)
        .where(eq(bitnoirUsersTable.referredByUserId, profile.id)),
      db
        .select({ total: count() })
        .from(bitnoirBnbDepositsTable)
        .where(
          and(
            eq(bitnoirBnbDepositsTable.userId, profile.id),
            eq(bitnoirBnbDepositsTable.status, "pending"),
          ),
        ),
      db
        .select({ total: count() })
        .from(bitnoirBnbWithdrawalsTable)
        .where(
          and(
            eq(bitnoirBnbWithdrawalsTable.userId, profile.id),
            eq(bitnoirBnbWithdrawalsTable.status, "pending"),
          ),
        ),
      db
        .select({ total: count() })
        .from(bitnoirFarmPositionsTable)
        .where(
          and(
            eq(bitnoirFarmPositionsTable.userId, profile.id),
            eq(bitnoirFarmPositionsTable.status, "active"),
            gt(bitnoirFarmPositionsTable.maturesAt, now),
          ),
        ),
      db
        .select({ total: count() })
        .from(bitnoirFarmPositionsTable)
        .where(
          and(
            eq(bitnoirFarmPositionsTable.userId, profile.id),
            eq(bitnoirFarmPositionsTable.status, "active"),
            lte(bitnoirFarmPositionsTable.maturesAt, now),
          ),
        ),
      referralRewardTotal(profile.id),
    ]);

    res.json(
      GetDashboardSummaryResponse.parse({
        bnbBalanceWei: profile.bnbBalanceWei,
        directReferralCount: referralCount?.total ?? 0,
        referralBitsEarned,
        pendingDepositCount: pendingDeposits?.total ?? 0,
        pendingWithdrawalCount: pendingWithdrawals?.total ?? 0,
        activeFarmCount: activeFarms?.total ?? 0,
        matureFarmCount: matureFarms?.total ?? 0,
      }),
    );
  },
);

router.get(
  "/referrals",
  requireSignedIn,
  requireActiveProfile,
  async (_req, res): Promise<void> => {
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const [referrals, rewardBits] = await Promise.all([
      db
        .select({
          username: bitnoirUsersTable.username,
          createdAt: bitnoirUsersTable.createdAt,
        })
        .from(bitnoirUsersTable)
        .where(eq(bitnoirUsersTable.referredByUserId, profile.id))
        .orderBy(desc(bitnoirUsersTable.createdAt)),
      referralRewardTotal(profile.id),
    ]);
    res.json(
      GetMyReferralsResponse.parse({
        referralCode: profile.referralCode,
        directReferralCount: referrals.length,
        rewardBits,
        referrals,
      }),
    );
  },
);

export default router;
