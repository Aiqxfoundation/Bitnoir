# Bitnoir Crypto Ecosystem

Bitnoir is an early-stage community account and BNB Smart Chain app. It provides user profiles, internal Bits points, referrals, wallet ownership verification, and carefully gated BNB accounting. It is not a wallet, smart contract, exchange, or live yield protocol.

## What works

- Clerk sign-in and account profiles. A new Bitnoir profile receives 100 internal Bits.
- A direct referral receives 10 Bits when the referred profile is created. Username/profile creation and both ledger entries are transactional.
- Internal Bits transfers use row locks, an idempotency key, and paired ledger entries.
- The public leaderboard exposes rank, username, and Bits balance only.
- Wallet ownership verification uses a short-lived, single-use signed message. The frontend supports injected EIP-6963/EIP-1193 providers for MetaMask, Trust Wallet, and OKX; it does not use WalletConnect or request recovery phrases/private keys.
- BNB deposit submissions are checked against BSC mainnet transactions, linked sender wallets, the configured treasury, successful receipts, and six confirmations. A deposit is credited only after Super Admin approval and a second server-side transaction check.
- BNB withdrawals reserve the requested amount atomically. The default fee is 2% (200 basis points); the user must choose an already verified BSC wallet. A withdrawal is not marked paid until the server verifies a successful, sufficiently confirmed treasury transaction for the exact payout. Rejection releases the reserved balance.
- Farming terms support 15, 30, 45, and 60 days. All start disabled. A configured annual rate is an estimate only; it is not paid or added to the account balance. A matured claim returns principal only. No yield provider or farming contract is connected.
- Administrative changes and BNB reviews are recorded in an audit log. The first user is never automatically promoted.

## Important operating limits

BNB accounting is an internal database ledger. Deposits, approvals, and manually executed withdrawals are custodial operations; the app does not provide an audited custody contract, proof of reserves, multisignature operations, or independent payout service. The repository has no live farming or yield source. Do not enable public deposits or describe an internal balance as on-chain until treasury, compliance, operational controls, and production monitoring have been reviewed.

Bits are internal points with no represented cash value. BTNR and the AI Agent are roadmap concepts, not deployed tokens or live AI services. The product guide documents referral, farming, roadmap, and risk boundaries.

## Local setup

1. Install dependencies with `pnpm install`.
2. Configure the Clerk integration/keys and the Replit-managed PostgreSQL database in the workspace; do not put real credentials in `.env.example` or Git.
3. Apply the development schema with `pnpm --filter @workspace/db run push`.
4. Start the `artifacts/api-server: API Server` and `artifacts/bitnoir: web` workflows.
5. Run checks with `pnpm --filter @workspace/api-server run test`, `pnpm --filter @workspace/api-server run typecheck`, and `pnpm -w run typecheck`.

The API contract is `lib/api-spec/openapi.yaml`. If it changes, regenerate the shared client and validators with `pnpm --filter @workspace/api-spec run codegen`.

## Environment configuration

See [`.env.example`](.env.example). Replit-managed Clerk values and the database URL belong in Replit's workspace/deployment configuration, never in source control.

- `BITNOIR_SUPER_ADMIN_CLERK_USER_ID`: one-time bootstrap allowlist. Sign in with the intended account, copy the Clerk user ID shown on the Admin Setup screen, set this value for the target environment, restart the API, then initialize from the screen. Development and production identities/configuration are separate. The first account to register is not an administrator.
- `BITNOIR_TREASURY_ADDRESS` and `BITNOIR_BSC_RPC_URL`: both must be valid before deposit and transaction-verification actions are enabled. Use a BSC mainnet RPC. If the provider URL contains an API token, store it through Replit Secrets.
- `BITNOIR_WITHDRAWAL_FEE_BPS`: optional; defaults to `200` (2%). Accepted range is 0–2500 basis points. The app reports the active fee and computes it using integer wei arithmetic.

Before publishing, configure the target environment's Clerk, database, initial Super Admin, treasury, and RPC settings, and apply the database schema to that environment. Deposits remain disabled when treasury/RPC configuration is missing.

