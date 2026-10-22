import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  boolean,
  check,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const bitnoirRoleEnum = pgEnum("bitnoir_role", ["user", "super_admin"]);
export const bitsLedgerKindEnum = pgEnum("bits_ledger_kind", [
  "signup",
  "referral",
  "transfer_in",
  "transfer_out",
]);

export const bitnoirUsersTable = pgTable(
  "bitnoir_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    username: varchar("username", { length: 24 }).notNull(),
    referralCode: varchar("referral_code", { length: 24 }).notNull(),
    referredByUserId: uuid("referred_by_user_id").references(
      (): AnyPgColumn => bitnoirUsersTable.id,
    ),
    bitsBalance: integer("bits_balance").notNull().default(0),
    bnbBalanceWei: numeric("bnb_balance_wei", { precision: 78, scale: 0 })
      .notNull()
      .default("0"),
    role: bitnoirRoleEnum("role").notNull().default("user"),
    suspended: boolean("suspended").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bitnoir_users_clerk_user_id_uq").on(table.clerkUserId),
    uniqueIndex("bitnoir_users_username_lower_uq").on(
      sql`lower(${table.username})`,
    ),
    uniqueIndex("bitnoir_users_referral_code_uq").on(table.referralCode),
    check("bitnoir_users_bits_nonnegative", sql`${table.bitsBalance} >= 0`),
    check(
      "bitnoir_users_bnb_nonnegative",
      sql`${table.bnbBalanceWei} >= 0`,
    ),
  ],
);

export const bitnoirPlatformSettingsTable = pgTable(
  "bitnoir_platform_settings",
  {
    id: integer("id").primaryKey(),
    superAdminUserId: uuid("super_admin_user_id").references(
      () => bitnoirUsersTable.id,
    ),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
  },
);

export const bitsTransfersTable = pgTable(
  "bits_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderUserId: uuid("sender_user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    amount: integer("amount").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bits_transfers_sender_idempotency_uq").on(
      table.senderUserId,
      table.idempotencyKey,
    ),
    check("bits_transfers_positive_amount", sql`${table.amount} > 0`),
    check(
      "bits_transfers_different_users",
      sql`${table.senderUserId} <> ${table.recipientUserId}`,
    ),
  ],
);

export const bitsLedgerTable = pgTable(
  "bits_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    relatedUserId: uuid("related_user_id").references(
      () => bitnoirUsersTable.id,
    ),
    transferId: uuid("transfer_id").references(() => bitsTransfersTable.id),
    kind: bitsLedgerKindEnum("kind").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    description: varchar("description", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bits_ledger_user_id_id_uq").on(table.userId, table.id),
    check("bits_ledger_balance_nonnegative", sql`${table.balanceAfter} >= 0`),
    check("bits_ledger_amount_nonzero", sql`${table.amount} <> 0`),
  ],
);

export const bitnoirWalletNoncesTable = pgTable("bitnoir_wallet_nonces", {
  nonce: varchar("nonce", { length: 128 }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => bitnoirUsersTable.id),
  message: text("message").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const bitnoirWalletsTable = pgTable(
  "bitnoir_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    address: varchar("address", { length: 42 }).notNull(),
    chainId: integer("chain_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bitnoir_wallets_address_uq").on(sql`lower(${table.address})`),
    check("bitnoir_wallets_chain_positive", sql`${table.chainId} > 0`),
  ],
);

export const bitnoirAuditEventsTable = pgTable("bitnoir_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => bitnoirUsersTable.id),
  action: varchar("action", { length: 100 }).notNull(),
  targetUserId: uuid("target_user_id").references(() => bitnoirUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBitnoirUserSchema = createInsertSchema(bitnoirUsersTable)
  .omit({ id: true, createdAt: true })
  .extend({
    username: z.string().min(3).max(24),
  });
export type BitnoirUser = typeof bitnoirUsersTable.$inferSelect;
export type InsertBitnoirUser = z.infer<typeof insertBitnoirUserSchema>;
export type BitsLedgerEntry = typeof bitsLedgerTable.$inferSelect;
export type BitsTransfer = typeof bitsTransfersTable.$inferSelect;
export type BitnoirWallet = typeof bitnoirWalletsTable.$inferSelect;
export type BitnoirAuditEvent = typeof bitnoirAuditEventsTable.$inferSelect;
