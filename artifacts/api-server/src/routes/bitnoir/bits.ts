import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bitnoirUsersTable,
  bitsLedgerTable,
  bitsTransfersTable,
  db,
} from "@workspace/db";
import {
  GetMyBitsLedgerQueryParams,
  GetMyBitsLedgerResponse,
  TransferBitsBody,
  TransferBitsResponse,
} from "@workspace/api-zod";
import {
  requireActiveProfile,
  requireSignedIn,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();
const MAX_BITS = 2_147_483_647;

router.get(
  "/bits/ledger",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = GetMyBitsLedgerQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const rows = await db
      .select()
      .from(bitsLedgerTable)
      .where(eq(bitsLedgerTable.userId, profile.id))
      .orderBy(desc(bitsLedgerTable.createdAt), asc(bitsLedgerTable.id))
      .limit(parsed.data.limit ?? 50)
      .offset(parsed.data.offset ?? 0);

    res.json(
      GetMyBitsLedgerResponse.parse(
        rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          amount: row.amount,
          balanceAfter: row.balanceAfter,
          description: row.description,
          createdAt: row.createdAt,
        })),
      ),
    );
  },
);

router.post(
  "/bits/transfers",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = TransferBitsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid transfer" });
      return;
    }
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const recipientUsername = parsed.data.recipientUsername
      .trim()
      .toLowerCase();
    if (recipientUsername === profile.username.toLowerCase()) {
      res.status(400).json({ error: "You cannot transfer Bits to yourself" });
      return;
    }

    try {
      const transfer = await db.transaction(async (tx) => {
        const [existingTransfer] = await tx
          .select()
          .from(bitsTransfersTable)
          .where(
            and(
              eq(bitsTransfersTable.senderUserId, profile.id),
              eq(bitsTransfersTable.idempotencyKey, parsed.data.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingTransfer) {
          const [originalRecipient] = await tx
            .select({ username: bitnoirUsersTable.username })
            .from(bitnoirUsersTable)
            .where(eq(bitnoirUsersTable.id, existingTransfer.recipientUserId))
            .limit(1);
          if (
            existingTransfer.amount !== parsed.data.amount ||
            originalRecipient?.username.toLowerCase() !== recipientUsername
          ) {
            throw new Error("IDEMPOTENCY_KEY_REUSED");
          }
          const [senderLedger] = await tx
            .select({ balanceAfter: bitsLedgerTable.balanceAfter })
            .from(bitsLedgerTable)
            .where(
              and(
                eq(bitsLedgerTable.transferId, existingTransfer.id),
                eq(bitsLedgerTable.userId, profile.id),
              ),
            )
            .limit(1);
          return {
            row: existingTransfer,
            senderBalance: senderLedger?.balanceAfter ?? profile.bitsBalance,
            recipientUsername,
          };
        }

        const [recipient] = await tx
          .select()
          .from(bitnoirUsersTable)
          .where(
            and(
              sql`lower(${bitnoirUsersTable.username}) = ${recipientUsername}`,
              eq(bitnoirUsersTable.suspended, false),
            ),
          )
          .limit(1);
        if (!recipient) {
          throw new Error("RECIPIENT_NOT_FOUND");
        }

        const lockedUsers = await tx
          .select({
            id: bitnoirUsersTable.id,
            bitsBalance: bitnoirUsersTable.bitsBalance,
            suspended: bitnoirUsersTable.suspended,
          })
          .from(bitnoirUsersTable)
          .where(inArray(bitnoirUsersTable.id, [profile.id, recipient.id]))
          .orderBy(asc(bitnoirUsersTable.id))
          .for("update");
        const sender = lockedUsers.find((user) => user.id === profile.id);
        const lockedRecipient = lockedUsers.find(
          (user) => user.id === recipient.id,
        );
        if (!sender || !lockedRecipient || lockedRecipient.suspended) {
          throw new Error("RECIPIENT_NOT_FOUND");
        }
        if (sender.bitsBalance < parsed.data.amount) {
          throw new Error("INSUFFICIENT_BITS");
        }
        if (lockedRecipient.bitsBalance > MAX_BITS - parsed.data.amount) {
          throw new Error("RECIPIENT_BALANCE_LIMIT");
        }

        const [updatedSender] = await tx
          .update(bitnoirUsersTable)
          .set({
            bitsBalance: sql`${bitnoirUsersTable.bitsBalance} - ${parsed.data.amount}`,
          })
          .where(
            and(
              eq(bitnoirUsersTable.id, profile.id),
              gte(bitnoirUsersTable.bitsBalance, parsed.data.amount),
            ),
          )
          .returning({ bitsBalance: bitnoirUsersTable.bitsBalance });
        const [updatedRecipient] = await tx
          .update(bitnoirUsersTable)
          .set({
            bitsBalance: sql`${bitnoirUsersTable.bitsBalance} + ${parsed.data.amount}`,
          })
          .where(eq(bitnoirUsersTable.id, recipient.id))
          .returning({ bitsBalance: bitnoirUsersTable.bitsBalance });
        if (!updatedSender || !updatedRecipient) {
          throw new Error("INSUFFICIENT_BITS");
        }

        const [created] = await tx
          .insert(bitsTransfersTable)
          .values({
            senderUserId: profile.id,
            recipientUserId: recipient.id,
            amount: parsed.data.amount,
            idempotencyKey: parsed.data.idempotencyKey,
          })
          .returning();
        if (!created) {
          throw new Error("TRANSFER_CREATE_FAILED");
        }
        await tx.insert(bitsLedgerTable).values([
          {
            userId: profile.id,
            relatedUserId: recipient.id,
            transferId: created.id,
            kind: "transfer_out",
            amount: -parsed.data.amount,
            balanceAfter: updatedSender.bitsBalance,
            description: `Transfer to ${recipient.username}`,
          },
          {
            userId: recipient.id,
            relatedUserId: profile.id,
            transferId: created.id,
            kind: "transfer_in",
            amount: parsed.data.amount,
            balanceAfter: updatedRecipient.bitsBalance,
            description: `Transfer from ${profile.username}`,
          },
        ]);

        return {
          row: created,
          senderBalance: updatedSender.bitsBalance,
          recipientUsername: recipient.username,
        };
      });

      res.status(201).json(
        TransferBitsResponse.parse({
          id: transfer.row.id,
          recipientUsername: transfer.recipientUsername,
          amount: transfer.row.amount,
          senderBalance: transfer.senderBalance,
          createdAt: transfer.row.createdAt,
        }),
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "RECIPIENT_NOT_FOUND") {
          res.status(404).json({ error: "Recipient not found" });
          return;
        }
        if (error.message === "INSUFFICIENT_BITS") {
          res.status(409).json({ error: "Insufficient Bits balance" });
          return;
        }
        if (error.message === "RECIPIENT_BALANCE_LIMIT") {
          res.status(409).json({ error: "Recipient balance limit reached" });
          return;
        }
        if (error.message === "IDEMPOTENCY_KEY_REUSED") {
          res.status(409).json({ error: "Idempotency key was already used for another transfer" });
          return;
        }
      }
      throw error;
    }
  },
);

export default router;
