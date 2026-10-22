# Bitnoir product, rules, and risk notes

## Product overview

Bitnoir is a community-facing account and participation app. It currently supports profiles, internal Bits points, direct referrals, wallet ownership checks, an internal BNB ledger, manual deposit/withdrawal review, and time-locked BNB positions. The app is not a decentralized exchange, custodial wallet, audited smart contract, or connected yield protocol.

## Bits and referrals

- Creating one Bitnoir profile awards 100 Bits once.
- A valid direct referral awards 10 Bits to the referrer in the same database transaction as the new profile and the referred user's welcome ledger entry.
- Usernames and referral codes are unique. Existing profiles cannot be recreated to claim another welcome/referral reward.
- Bits transfers are internal points transfers, not blockchain transactions. The sender and recipient ledger records and balances update atomically. Idempotency keys prevent replaying one transfer as a second payment.
- Bits do not represent BNB, BTNR, a security, or a cash redemption right.
- The public leaderboard contains rank, username, and Bits balance only.

## Wallets and BNB deposits

- Wallet verification signs a one-time message that identifies the Bitnoir profile and expires after five minutes. The signature proves address control; it does not authorize a transaction.
- Supported browser wallet providers are MetaMask, Trust Wallet, and OKX through EIP-6963 discovery/EIP-1193 injection. No seed phrase or private key is requested or sent to Bitnoir.
- Wallet association supports BSC mainnet and testnet for ownership verification. Deposits and withdrawals are BSC mainnet only (chain ID 56).
- Deposits require a configured treasury address and RPC URL. The API independently checks the transaction hash, successful receipt, native BNB value, treasury destination, verified sender wallet, chain, and six confirmations.
- Submitting a hash creates a pending review request; it does not credit a balance. Super Admin approval re-checks the transaction and then writes the credit and ledger entry atomically.
- The displayed BNB balance is internal bookkeeping. It is not a live wallet balance, a token balance, proof of reserves, or an on-chain claim.

## Withdrawals

- The default withdrawal fee is 200 basis points (2%) of the requested gross amount. The fee is rounded down to whole wei; the payout is the remaining amount.
- The destination must be a wallet already verified on the user's Bitnoir profile for BSC mainnet.
- Request creation reserves the full gross amount in one database transaction. It remains pending while the treasury makes a manual transfer.
- The app marks a request paid only after verifying that the treasury sent the exact net payout to the recorded destination on BSC mainnet and the transaction has six confirmations.
- A rejected pending request returns its reserved gross amount to the internal balance. A completed payment is not automatically reversed.
- The fee can be changed by setting `BITNOIR_WITHDRAWAL_FEE_BPS` (0–2500) in the target environment. The current fee is returned by the public configuration endpoint and shown before a user submits a request.

## Farming terms and claims

- Available durations are 15, 30, 45, and 60 days. No term or rate is enabled by default.
- Super Admin may configure an annual rate as an informational projection. The displayed estimate uses integer arithmetic and a simple annualized formula; it is not a promise, realized yield, or payable reward.
- Starting a position reserves the user's internal BNB balance. At maturity, the claim credits back principal only. The projected estimate is not credited.
- No external farming protocol, smart contract, or yield source is connected. Enabling a term does not create an on-chain farming position or generate BNB.

## Super Admin and audit

- Super Admin initialization requires a signed-in account whose Clerk user ID exactly matches `BITNOIR_SUPER_ADMIN_CLERK_USER_ID`.
- Initialization is a one-time transaction. It locks the platform settings row, changes the configured profile role, and records an audit entry. New users always receive the ordinary user role.
- Admin routes re-check the authenticated database role. Account suspension, deposit decisions, withdrawal decisions, Super Admin initialization, and farming-term changes are audit logged.
- Never share Clerk secret keys, RPC provider credentials, private keys, or recovery phrases. Store credentials in Replit Secrets.

## Roadmap and limitations

BTNR is a concept only: there is no token contract, token balance, exchange listing, or token transaction in this build. The AI Agent is a future vision; no live AI actions, trades, or blockchain analytics are presented as completed.

Before turning on real public deposits, have qualified reviewers assess legal/regulatory obligations, custody architecture, treasury/multisig procedures, incident response, accounting/reconciliation, and a third-party security audit. The current application does not provide these controls or assurances. This guide is product information, not investment, financial, or legal advice.
