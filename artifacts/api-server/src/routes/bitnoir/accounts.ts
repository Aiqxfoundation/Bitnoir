import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirUsersTable,
  bitsLedgerTable,
  db,
} from "@workspace/db";
import {
  CreateMyProfileBody,
  CreateMyProfileResponse,
  GetLeaderboardQueryParams,
  GetLeaderboardResponse,
  GetMyProfileResponse,
} from "@workspace/api-zod";
import { requireSignedIn } from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();

function createReferralCode(): string {
  return randomBytes(8).toString("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

router.get("/leaderboard", async (req, res): Promise<void> => {
  const parsed = GetLeaderboardQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pagination parameters" });
    return;
  }
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;
  const rows = await db
    .select({
      username: bitnoirUsersTable.username,
      bitsBalance: bitnoirUsersTable.bitsBalance,
    })
    .from(bitnoirUsersTable)
    .where(eq(bitnoirUsersTable.suspended, false))
    .orderBy(desc(bitnoirUsersTable.bitsBalance), bitnoirUsersTable.createdAt)
    .limit(limit)
    .offset(offset);

  res.json(
    GetLeaderboardResponse.parse(
      rows.map((row, index) => ({
        rank: offset + index + 1,
        username: row.username,
        bitsBalance: row.bitsBalance,
      })),
    ),
  );
});

router.get("/users/me", requireSignedIn, async (_req, res): Promise<void> => {
  const clerkUserId = res.locals.clerkUserId as string;
  const [user] = await db
    .select()
    .from(bitnoirUsersTable)
    .where(eq(bitnoirUsersTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "Profile has not been created" });
    return;
  }
  if (user.suspended) {
    res.status(403).json({ error: "This account is suspended" });
    return;
  }

  let referredByUsername: string | null = null;
  if (user.referredByUserId) {
    const [referrer] = await db
      .select({ username: bitnoirUsersTable.username })
      .from(bitnoirUsersTable)
      .where(eq(bitnoirUsersTable.id, user.referredByUserId))
      .limit(1);
    referredByUsername = referrer?.username ?? null;
  }

  res.json(
    GetMyProfileResponse.parse({
      id: user.id,
      username: user.username,
      bitsBalance: user.bitsBalance,
      referralCode: user.referralCode,
      referredByUsername,
      role: user.role,
      createdAt: user.createdAt,
    }),
  );
});

router.post("/users/me", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateMyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid username or referral code" });
    return;
  }

  const clerkUserId = res.locals.clerkUserId as string;
  const username = parsed.data.username.trim().toLowerCase();
  const referralCode = parsed.data.referralCode?.trim().toLowerCase();
  try {
    const creation = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: bitnoirUsersTable.id })
        .from(bitnoirUsersTable)
        .where(eq(bitnoirUsersTable.clerkUserId, clerkUserId))
        .limit(1);
      if (existing) {
        throw new Error("PROFILE_ALREADY_EXISTS");
      }

      const [usernameMatch] = await tx
        .select({ id: bitnoirUsersTable.id })
        .from(bitnoirUsersTable)
        .where(sql`lower(${bitnoirUsersTable.username}) = ${username}`)
        .limit(1);
      if (usernameMatch) {
        throw new Error("USERNAME_TAKEN");
      }

      let referrer: typeof bitnoirUsersTable.$inferSelect | undefined;
      if (referralCode) {
        const [foundReferrer] = await tx
          .select()
          .from(bitnoirUsersTable)
          .where(
            and(
              eq(bitnoirUsersTable.referralCode, referralCode),
              eq(bitnoirUsersTable.suspended, false),
            ),
          )
          .limit(1);
        if (!foundReferrer) {
          throw new Error("INVALID_REFERRAL");
        }
        if (foundReferrer.clerkUserId === clerkUserId) {
          throw new Error("SELF_REFERRAL");
        }
        referrer = foundReferrer;
      }

      const [created] = await tx
        .insert(bitnoirUsersTable)
        .values({
          clerkUserId,
          username,
          referralCode: createReferralCode(),
          referredByUserId: referrer?.id ?? null,
          bitsBalance: 100,
          role: "user",
        })
        .returning();
      if (!created) {
        throw new Error("PROFILE_CREATE_FAILED");
      }

      await tx.insert(bitsLedgerTable).values({
        userId: created.id,
        kind: "signup",
        amount: 100,
        balanceAfter: 100,
        description: "Welcome bonus",
      });

      if (referrer) {
        const [updatedReferrer] = await tx
          .update(bitnoirUsersTable)
          .set({ bitsBalance: sql`${bitnoirUsersTable.bitsBalance} + 10` })
          .where(eq(bitnoirUsersTable.id, referrer.id))
          .returning({
            id: bitnoirUsersTable.id,
            bitsBalance: bitnoirUsersTable.bitsBalance,
          });
        if (!updatedReferrer) {
          throw new Error("REFERRER_UPDATE_FAILED");
        }
        await tx.insert(bitsLedgerTable).values({
          userId: referrer.id,
          relatedUserId: created.id,
          kind: "referral",
          amount: 10,
          balanceAfter: updatedReferrer.bitsBalance,
          description: `Direct referral: ${username}`,
        });
      }

      return {
        profile: created,
        referredByUsername: referrer?.username ?? null,
      };
    });
    const { profile, referredByUsername } = creation;

    res.status(201).json(
      CreateMyProfileResponse.parse({
        id: profile.id,
        username: profile.username,
        bitsBalance: profile.bitsBalance,
        referralCode: profile.referralCode,
        referredByUsername,
        role: profile.role,
        createdAt: profile.createdAt,
      }),
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "PROFILE_ALREADY_EXISTS") {
        res.status(409).json({ error: "Profile already exists" });
        return;
      }
      if (error.message === "USERNAME_TAKEN") {
        res.status(409).json({ error: "Username is already taken" });
        return;
      }
      if (error.message === "INVALID_REFERRAL") {
        res.status(400).json({ error: "Referral code is invalid" });
        return;
      }
      if (error.message === "SELF_REFERRAL") {
        res.status(400).json({ error: "You cannot refer your own account" });
        return;
      }
    }
    if (isUniqueViolation(error)) {
      const existingProfile = await db
        .select({ id: bitnoirUsersTable.id })
        .from(bitnoirUsersTable)
        .where(eq(bitnoirUsersTable.clerkUserId, clerkUserId))
        .limit(1);
      if (existingProfile.length > 0) {
        res.status(409).json({ error: "Profile already exists" });
        return;
      }
      res.status(409).json({ error: "Username or referral code is already taken" });
      return;
    }
    throw error;
  }
});

export default router;
