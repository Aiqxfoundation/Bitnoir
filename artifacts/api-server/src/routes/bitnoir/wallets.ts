import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAddress, verifyMessage, type Hex } from "viem";
import {
  bitnoirWalletNoncesTable,
  bitnoirWalletsTable,
  bitnoirUsersTable,
  db,
} from "@workspace/db";
import {
  GetMyWalletsResponse,
  GetWalletNonceResponse,
  VerifyWalletBody,
  VerifyWalletResponse,
} from "@workspace/api-zod";
import {
  requireActiveProfile,
  requireSignedIn,
} from "../../middlewares/requireBitnoirUser";

const router: IRouter = Router();
const supportedBnbChainIds = new Set([56, 97]);
const challengeLifetimeMs = 5 * 60 * 1000;

router.get(
  "/wallets/nonce",
  requireSignedIn,
  requireActiveProfile,
  async (_req, res): Promise<void> => {
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + challengeLifetimeMs);
    const message = [
      "Bitnoir wallet verification",
      `Account: ${profile.id}`,
      `Nonce: ${nonce}`,
      `Expires at: ${expiresAt.toISOString()}`,
      "This signature proves wallet ownership only; it does not authorize transactions.",
    ].join("\n");
    await db.insert(bitnoirWalletNoncesTable).values({
      nonce,
      userId: profile.id,
      message,
      expiresAt,
    });

    res.json(
      GetWalletNonceResponse.parse({
        nonce,
        message,
        expiresAt,
      }),
    );
  },
);

router.post(
  "/wallets/verify",
  requireSignedIn,
  requireActiveProfile,
  async (req, res): Promise<void> => {
    const parsed = VerifyWalletBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid wallet verification request" });
      return;
    }
    if (!supportedBnbChainIds.has(parsed.data.chainId)) {
      res.status(400).json({ error: "Connect to BNB Smart Chain or its testnet" });
      return;
    }

    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const [challenge] = await db
      .select()
      .from(bitnoirWalletNoncesTable)
      .where(
        and(
          eq(bitnoirWalletNoncesTable.nonce, parsed.data.nonce),
          eq(bitnoirWalletNoncesTable.userId, profile.id),
          isNull(bitnoirWalletNoncesTable.usedAt),
          gt(bitnoirWalletNoncesTable.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!challenge) {
      res.status(400).json({ error: "Wallet challenge is invalid or expired" });
      return;
    }

    let address: string;
    let validSignature = false;
    try {
      address = getAddress(parsed.data.address);
      validSignature = await verifyMessage({
        address: address as `0x${string}`,
        message: challenge.message,
        signature: parsed.data.signature as Hex,
      });
    } catch {
      res.status(400).json({ error: "Wallet signature is invalid" });
      return;
    }
    if (!validSignature) {
      res.status(400).json({ error: "Wallet signature is invalid" });
      return;
    }

    try {
      const wallet = await db.transaction(async (tx) => {
        const [lockedChallenge] = await tx
          .select()
          .from(bitnoirWalletNoncesTable)
          .where(
            and(
              eq(bitnoirWalletNoncesTable.nonce, parsed.data.nonce),
              eq(bitnoirWalletNoncesTable.userId, profile.id),
              isNull(bitnoirWalletNoncesTable.usedAt),
              gt(bitnoirWalletNoncesTable.expiresAt, new Date()),
            ),
          )
          .for("update");
        if (!lockedChallenge) {
          throw new Error("CHALLENGE_ALREADY_USED");
        }

        const [existingWallet] = await tx
          .select()
          .from(bitnoirWalletsTable)
          .where(sql`lower(${bitnoirWalletsTable.address}) = ${address.toLowerCase()}`)
          .limit(1);
        if (existingWallet && existingWallet.userId !== profile.id) {
          throw new Error("WALLET_ALREADY_LINKED");
        }

        await tx
          .update(bitnoirWalletNoncesTable)
          .set({ usedAt: new Date() })
          .where(eq(bitnoirWalletNoncesTable.nonce, parsed.data.nonce));
        if (existingWallet) {
          return existingWallet;
        }

        const [createdWallet] = await tx
          .insert(bitnoirWalletsTable)
          .values({
            userId: profile.id,
            address,
            chainId: parsed.data.chainId,
          })
          .returning();
        if (!createdWallet) {
          throw new Error("WALLET_CREATE_FAILED");
        }
        return createdWallet;
      });

      res.json(
        VerifyWalletResponse.parse({
          address: wallet.address,
          chainId: wallet.chainId,
          verifiedAt: wallet.verifiedAt,
        }),
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "WALLET_ALREADY_LINKED") {
          res.status(409).json({ error: "Wallet is already linked to another account" });
          return;
        }
        if (error.message === "CHALLENGE_ALREADY_USED") {
          res.status(400).json({ error: "Wallet challenge has already been used" });
          return;
        }
        if (error.message === "23505") {
          res.status(409).json({ error: "Wallet is already linked to another account" });
          return;
        }
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        res.status(409).json({ error: "Wallet is already linked to another account" });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/wallets",
  requireSignedIn,
  requireActiveProfile,
  async (_req, res): Promise<void> => {
    const profile = res.locals.bitnoirProfile as typeof bitnoirUsersTable.$inferSelect;
    const wallets = await db
      .select({
        address: bitnoirWalletsTable.address,
        chainId: bitnoirWalletsTable.chainId,
        verifiedAt: bitnoirWalletsTable.verifiedAt,
      })
      .from(bitnoirWalletsTable)
      .where(eq(bitnoirWalletsTable.userId, profile.id))
      .orderBy(desc(bitnoirWalletsTable.verifiedAt));
    res.json(GetMyWalletsResponse.parse(wallets));
  },
);

export default router;
