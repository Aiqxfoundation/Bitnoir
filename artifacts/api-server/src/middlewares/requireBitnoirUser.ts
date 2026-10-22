import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { bitnoirUsersTable, db } from "@workspace/db";

export const requireSignedIn: RequestHandler = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.locals.clerkUserId = userId;
  next();
};

export const requireActiveProfile: RequestHandler = async (_req, res, next) => {
  const clerkUserId = res.locals.clerkUserId as string | undefined;
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [profile] = await db
    .select()
    .from(bitnoirUsersTable)
    .where(
      and(
        eq(bitnoirUsersTable.clerkUserId, clerkUserId),
        eq(bitnoirUsersTable.suspended, false),
      ),
    )
    .limit(1);
  if (!profile) {
    res.status(403).json({ error: "Active Bitnoir profile required" });
    return;
  }

  res.locals.bitnoirProfile = profile;
  next();
};

export const requireSuperAdmin: RequestHandler = async (_req, res, next) => {
  const clerkUserId = res.locals.clerkUserId as string | undefined;
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [profile] = await db
    .select()
    .from(bitnoirUsersTable)
    .where(
      and(
        eq(bitnoirUsersTable.clerkUserId, clerkUserId),
        eq(bitnoirUsersTable.suspended, false),
      ),
    )
    .limit(1);
  if (!profile || profile.role !== "super_admin") {
    res.status(403).json({ error: "Super Admin access required" });
    return;
  }

  res.locals.bitnoirProfile = profile;
  next();
};
