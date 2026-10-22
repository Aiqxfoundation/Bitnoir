import { sql } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";
import { bitnoirUsersTable } from "./bitnoir";

export const bnbDepositStatusEnum = pgEnum("bnb_deposit_status", [
  "pending",
  "approved",
  "rejected",
]);

export const bnbWithdrawalStatusEnum = pgEnum("bnb_withdrawal_status", [
  "pending",
  "paid",
  "rejected",
]);

export const bnbLedgerKindEnum = pgEnum("bnb_ledger_kind", [
  "deposit",
  "withdrawal_request",
  "withdrawal_reversal",
  "farm_lock",
  "farm_claim",
]);

export const farmPositionStatusEnum = pgEnum("farm_position_status", [
  "active",
  "claimed",
]);

const weiColumn = (name: string) =>
  numeric(name, { precision: 78, scale: 0 });

export const bitnoirBnbDepositsTable = pgTable(
  "bitnoir_bnb_deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    senderAddress: varchar("sender_address", { length: 42 }).notNull(),
    amountWei: weiColumn("amount_wei").notNull(),
    chainId: integer("chain_id").notNull().default(56),
    confirmations: integer("confirmations").notNull().default(0),
    status: bnbDepositStatusEnum("status").notNull().default("pending"),
    rejectionNote: varchar("rejection_note", { length: 200 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(
      () => bitnoirUsersTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bitnoir_bnb_deposits_tx_hash_uq").on(table.txHash),
    check("bitnoir_bnb_deposits_amount_positive", sql`${table.amountWei} > 0`),
    check("bitnoir_bnb_deposits_chain_bsc", sql`${table.chainId} = 56`),
    check(
      "bitnoir_bnb_deposits_confirmations_nonnegative",
      sql`${table.confirmations} >= 0`,
    ),
  ],
);

export const bitnoirBnbWithdrawalsTable = pgTable(
  "bitnoir_bnb_withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    amountWei: weiColumn("amount_wei").notNull(),
    feeWei: weiColumn("fee_wei").notNull(),
    payoutWei: weiColumn("payout_wei").notNull(),
    destinationAddress: varchar("destination_address", { length: 42 }).notNull(),
    status: bnbWithdrawalStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 66 }),
    rejectionNote: varchar("rejection_note", { length: 200 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(
      () => bitnoirUsersTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bitnoir_bnb_withdrawals_tx_hash_uq")
      .on(table.txHash)
      .where(sql`${table.txHash} is not null`),
    check("bitnoir_bnb_withdrawals_amount_positive", sql`${table.amountWei} > 0`),
    check("bitnoir_bnb_withdrawals_fee_nonnegative", sql`${table.feeWei} >= 0`),
    check("bitnoir_bnb_withdrawals_payout_positive", sql`${table.payoutWei} > 0`),
    check(
      "bitnoir_bnb_withdrawals_amounts_match",
      sql`${table.amountWei} = ${table.feeWei} + ${table.payoutWei}`,
    ),
  ],
);

export const bitnoirBnbLedgerTable = pgTable(
  "bitnoir_bnb_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    referenceId: uuid("reference_id"),
    kind: bnbLedgerKindEnum("kind").notNull(),
    amountWei: weiColumn("amount_wei").notNull(),
    balanceAfterWei: weiColumn("balance_after_wei").notNull(),
    description: varchar("description", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("bitnoir_bnb_ledger_amount_nonzero", sql`${table.amountWei} <> 0`),
    check(
      "bitnoir_bnb_ledger_balance_nonnegative",
      sql`${table.balanceAfterWei} >= 0`,
    ),
  ],
);

export const bitnoirFarmingTermsTable = pgTable(
  "bitnoir_farming_terms",
  {
    durationDays: integer("duration_days").primaryKey(),
    annualRateBps: integer("annual_rate_bps"),
    enabled: boolean("enabled").notNull().default(false),
    updatedByUserId: uuid("updated_by_user_id").references(
      () => bitnoirUsersTable.id,
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "bitnoir_farming_terms_duration_allowed",
      sql`${table.durationDays} in (15, 30, 45, 60)`,
    ),
    check(
      "bitnoir_farming_terms_rate_range",
      sql`${table.annualRateBps} is null or (${table.annualRateBps} >= 0 and ${table.annualRateBps} <= 10000)`,
    ),
  ],
);

export const bitnoirFarmPositionsTable = pgTable(
  "bitnoir_farm_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => bitnoirUsersTable.id),
    principalWei: weiColumn("principal_wei").notNull(),
    estimatedRewardWei: weiColumn("estimated_reward_wei").notNull().default("0"),
    termDays: integer("term_days").notNull(),
    annualRateBps: integer("annual_rate_bps").notNull(),
    status: farmPositionStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    maturesAt: timestamp("matures_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    check("bitnoir_farm_positions_principal_positive", sql`${table.principalWei} > 0`),
    check(
      "bitnoir_farm_positions_estimate_nonnegative",
      sql`${table.estimatedRewardWei} >= 0`,
    ),
    check(
      "bitnoir_farm_positions_duration_allowed",
      sql`${table.termDays} in (15, 30, 45, 60)`,
    ),
    check(
      "bitnoir_farm_positions_rate_range",
      sql`${table.annualRateBps} >= 0 and ${table.annualRateBps} <= 10000`,
    ),
  ],
);

export type BnbDeposit = typeof bitnoirBnbDepositsTable.$inferSelect;
export type BnbWithdrawal = typeof bitnoirBnbWithdrawalsTable.$inferSelect;
export type BnbLedgerEntry = typeof bitnoirBnbLedgerTable.$inferSelect;
export type FarmPosition = typeof bitnoirFarmPositionsTable.$inferSelect;
export type FarmingTerm = typeof bitnoirFarmingTermsTable.$inferSelect;
