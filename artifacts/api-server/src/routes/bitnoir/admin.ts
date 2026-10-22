import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirAuditEventsTable,
  bitnoirUsersTable,
  bitsLedgerTable,
  db,
} from "@workspace/db";
import {
  GetAdminBitsLedgerQueryParams,
  GetAdminBitsLedgerResponse,
  GetAdminAuditLogQueryParams,
  GetAdminAuditLogResponse,
  GetAdminUsersQueryParams,
  GetAdminUsersResponse,
  SetUserSuspensionBody,
  SetUserSuspensionParams,
  SetUserSuspensionResponse,
} from "@workspace/api-zod";
import {
  requireSignedIn,
  requireSuperAdmin,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();

router.get(
  "/admin/users",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = GetAdminUsersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const users = await db
      .select({
        id: bitnoirUsersTable.id,
        username: bitnoirUsersTable.username,
        bitsBalance: bitnoirUsersTable.bitsBalance,
        role: bitnoirUsersTable.role,
        suspended: bitnoirUsersTable.suspended,
        createdAt: bitnoirUsersTable.createdAt,
      })
      .from(bitnoirUsersTable)
      .orderBy(desc(bitnoirUsersTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(GetAdminUsersResponse.parse(users));
  },
);

router.patch(
  "/admin/users/:userId/suspension",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = SetUserSuspensionParams.safeParse(req.params);
    const body = SetUserSuspensionBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid account status request" });
      return;
    }
    const actor = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const [target] = await db
      .select()
      .from(bitnoirUsersTable)
      .where(eq(bitnoirUsersTable.id, params.data.userId))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (target.id === actor.id || target.role === "super_admin") {
      res.status(403).json({ error: "The Super Admin account cannot be suspended" });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const [user] = await tx
        .update(bitnoirUsersTable)
        .set({ suspended: body.data.suspended })
        .where(
          and(
            eq(bitnoirUsersTable.id, target.id),
            eq(bitnoirUsersTable.role, "user"),
          ),
        )
        .returning();
      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }
      await tx.insert(bitnoirAuditEventsTable).values({
        actorUserId: actor.id,
        targetUserId: target.id,
        action: body.data.suspended ? "account_suspended" : "account_unsuspended",
      });
      return user;
    });

    res.json(
      SetUserSuspensionResponse.parse({
        id: updated.id,
        username: updated.username,
        bitsBalance: updated.bitsBalance,
        role: updated.role,
        suspended: updated.suspended,
        createdAt: updated.createdAt,
      }),
    );
  },
);

router.get(
  "/admin/ledger",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = GetAdminBitsLedgerQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const rows = await db
      .select({
        id: bitsLedgerTable.id,
        username: bitnoirUsersTable.username,
        kind: bitsLedgerTable.kind,
        amount: bitsLedgerTable.amount,
        balanceAfter: bitsLedgerTable.balanceAfter,
        description: bitsLedgerTable.description,
        createdAt: bitsLedgerTable.createdAt,
      })
      .from(bitsLedgerTable)
      .innerJoin(
        bitnoirUsersTable,
        eq(bitsLedgerTable.userId, bitnoirUsersTable.id),
      )
      .orderBy(desc(bitsLedgerTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    res.json(GetAdminBitsLedgerResponse.parse(rows));
  },
);

router.get(
  "/admin/audit",
  requireSignedIn,
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const parsed = GetAdminAuditLogQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const rows = await db
      .select({
        id: bitnoirAuditEventsTable.id,
        actorUsername: bitnoirUsersTable.username,
        targetUserId: bitnoirAuditEventsTable.targetUserId,
        action: bitnoirAuditEventsTable.action,
        createdAt: bitnoirAuditEventsTable.createdAt,
      })
      .from(bitnoirAuditEventsTable)
      .innerJoin(
        bitnoirUsersTable,
        eq(bitnoirAuditEventsTable.actorUserId, bitnoirUsersTable.id),
      )
      .orderBy(desc(bitnoirAuditEventsTable.createdAt))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);
    const targetIds = [
      ...new Set(
        rows
          .map((row) => row.targetUserId)
          .filter((value): value is string => value !== null),
      ),
    ];
    const targets = targetIds.length
      ? await db
          .select({
            id: bitnoirUsersTable.id,
            username: bitnoirUsersTable.username,
          })
          .from(bitnoirUsersTable)
          .where(inArray(bitnoirUsersTable.id, targetIds))
      : [];
    const targetNames = new Map(targets.map((target) => [target.id, target.username]));

    res.json(
      GetAdminAuditLogResponse.parse(
        rows.map((row) => ({
          id: row.id,
          actorUsername: row.actorUsername,
          action: row.action,
          targetUsername: row.targetUserId
            ? (targetNames.get(row.targetUserId) ?? null)
            : null,
          createdAt: row.createdAt,
        })),
      ),
    );
  },
);

export default router;
