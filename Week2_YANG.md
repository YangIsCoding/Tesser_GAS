
# PaymentsService Technical Report (Top-Down Overview)

---

## 1. Service Scope and Responsibilities

`PaymentsService` is a core NestJS service responsible for managing the full **Payment lifecycle**:

1. Creating a payment (accounts can be attached later)
2. Asynchronously calculating exchange rates and completing missing amounts (via worker)
3. Binding accounts and assets, then generating execution steps
4. Executing payments (Turnkey signing + on-chain submission or provider offramp)
5. Querying payment records with full contextual data (steps, accounts, originator, reviewer, offramp data)

This service separates business intent (Payment) from execution logic (Steps).

---

## 2. Imports and External Dependencies

### 2.1 NestJS & Error Handling

* `BadRequestException`, `NotFoundException` – API-level validation errors
* `Logger` – structured logging
* `Inject`, `forwardRef` – dependency injection & circular dependency resolution

---

### 2.2 Business Rules (tesser-payments/types)

* `STABLECOIN_CURRENCIES` – defines crypto stablecoins
* `mapNetworkToAlfred` – maps internal network names to Alfred provider values
* `convertToSmallestUnits`, `getDecimalsForCurrency` – currency precision handling
* `NetworkKey` – multi-chain network identifier

---

### 2.3 Blockchain Utilities (viem)

Used for EVM transaction assembly and validation:

* `encodeFunctionData` / `decodeFunctionData` – build & decode ERC20 calldata
* `parseTransaction` / `serializeTransaction` – raw transaction parsing
* `erc20Abi`, `getAddress` – ERC20 ABI and checksum validation

---

### 2.4 Database (Drizzle ORM)

* `tx` – transaction context
* `eq`, `and`, `inArray`, `sql` – query builders
* Tables:
  `paymentsTable`, `stepsTable`, `accountsTable`,
  `entitiesTable`, `offrampTransactionsTable`,
  `organizationFiatAccountsTable`, etc.

---

## 3. Data Models (Interfaces)

### 3.1 PaymentWithSteps

Represents a complete payment record returned to API consumers.

Includes:

* `payment` – one row from paymentsTable
* `steps` – execution steps ordered by sequence
* `offrampTransaction?` – provider transaction if applicable
* `fiatAccount?` – bank account data for offramp
* `originator?` – business/entity initiating payment
* `reviewer?` – compliance reviewer
* Beneficiary bank information (country, bank name, account number)

Purpose:

> Provide a complete payment summary to the frontend.

---

### 3.2 PaymentWithAccountInfo

Extends `PaymentWithSteps` for list/table display.

Adds:

* `sourceWalletAddress`
* `blockchain`
* `recipientName`
* `bankName`
* `accountNumber`
* `txHash`

Purpose:

> Used for workspace payment listing APIs.

---

### 3.3 PaymentWithBalance

Extends `PaymentWithSteps` with:

* `hasSufficientBalance: boolean`

Purpose:

> Used to determine execution eligibility.

---

## 4. Dependency Injection (Constructor)

Injected services:

* `DatabaseService` – database operations
* `BlockchainService` – nonce, gas, submission
* `TransactionMonitorService` – dev-mode monitoring
* `RampsService` – Alfred offramp integration
* `EntitiesService` – custodial entity resolution
* `MessagePublisherService` – async worker messaging
* `WebhookService` – webhook payload construction
* `CurrencyService` – exchange rate logic

`forwardRef()` is used for webhookService to avoid circular dependency.

---

## 5. Core Utility Functions

### 5.1 isCurrencyFiat()

Determines currency type using `STABLECOIN_CURRENCIES`.

* Not in stablecoin list → fiat
* In stablecoin list → crypto

Used to determine:

* paymentType
* network requirements
* beneficiary asset rules

---

### 5.2 decimalStringToMicrounits()

Converts string decimal amounts into 6-decimal BigInt.

Example:

```
"10001.5" → 10001500000n
```

Avoids floating-point errors.

Used for on-chain amount representation.

---

## 6. Payment Creation Flow

### 6.1 createPaymentFromExchangeRate()

This is the primary entry point.

### Phase A – DB Transaction

1. Validate currencies
2. Determine paymentType:

   * crypto → fiat = offramp
   * crypto → crypto = onchain
   * fiat → crypto = not supported
3. Validate network rules
4. Enforce amount rule:

   * Exactly one of fromAmount or toAmount must be provided
5. Insert payment record:

   * exchangeRate = null
   * amounts stored as-is
   * network & currency stored for worker use

Return immediately with empty steps.

---

### Phase B – Async Worker Trigger

After transaction:

1. Publish message `quoteSubmitted`
2. Send webhook event `payment.created`

---

## 7. Worker Processing

### calculateAndUpdateExchangeRate(paymentId)

Worker performs:

1. Retrieve payment
2. Skip if exchangeRate already exists
3. Call `currencyService.calculateExchangeRate`
4. Compute missing amount
5. Set `quoteExpiresAt = now + 24h`
6. Update payment record

Errors are logged but not thrown.

---

## 8. Account Binding and Step Generation

### addAccountsToPaymentAsync()

After exchange rate is ready:

1. Validate workspace access
2. Ensure quote not expired
3. Validate accounts and assets
4. Update payment with account IDs
5. Delete existing steps
6. Regenerate steps

---

## 9. Step Generation Logic

### Onchain (crypto → crypto)

Creates 1 step:

```
Step 0:
  type = transfer
  fromAccount = source
  toAccount = beneficiary wallet
  amount = BigInt microunits
```

---

### Offramp (crypto → fiat)

Creates 2 steps:

```
Step 0: transfer
  source → providerDepositAddress

Step 1: offramp
  provider → fiat bank account
```

Includes:

* Alfred quote
* Alfred transaction creation
* Deposit address resolution

---

## 10. Payment Execution (executePayment)

This is the most critical part.

### 10.1 Validation

* Ensure quote not expired
* Ensure accounts bound
* Ensure signature (Turnkey stamp) exists

---

### 10.2 Build Unsigned Transaction

* Determine token contract
* Encode ERC20 transfer
* Fetch nonce & gas
* Estimate gas + 10% buffer
* Serialize unsigned transaction

---

### 10.3 Turnkey Signing

* POST to Turnkey API
* Pass stamp header
* Receive signedTransaction
* Validate signature status

---

### 10.4 Transaction Integrity Verification

Parse signed transaction:

* Decode ERC20 transfer
* Verify:

  * Destination address matches step
  * Amount matches step

If mismatch → reject execution.

---

### 10.5 Submit On-Chain

1. Update step.submittedAt
2. Submit transaction
3. Save txHash
4. Send webhook `payment.submitted`
5. Publish `balanceCheckRequested` message

---

# Complete Payment Lifecycle Flow

```
Client API Call
        │
        ▼
createPaymentFromExchangeRate()
        │
        │ Validate rules
        │ Insert payment (exchangeRate = null)
        ▼
Publish "quoteSubmitted"
        │
        ▼
Worker
        │
        ▼
calculateAndUpdateExchangeRate()
        │
        │ Compute rate
        │ Complete missing amount
        │ Set expiry
        ▼
addAccountsToPaymentAsync()
        │
        │ Validate accounts
        │ Attach assets
        │ Regenerate steps
        ▼
Steps Created
        │
        ├── Onchain
        │     └── Step 0: transfer
        │
        └── Offramp
              ├── Step 0: transfer
              └── Step 1: offramp
        │
        ▼
executePayment()
        │
        │ Build unsigned tx
        │ Turnkey sign
        │ Verify signature integrity
        │ Submit to blockchain
        ▼
Webhook + Message Events
```

---

# Architectural Summary

`PaymentsService` implements a workflow-driven payment system that:

* Separates business intent (Payment) from execution steps (Steps)
* Uses asynchronous workers for rate calculation
* Supports multi-step execution flows
* Ensures cryptographic integrity through transaction decoding validation
* Integrates external provider (Alfred) for fiat offramp
* Uses Turnkey for secure transaction signing
* Emits webhook and message events for state synchronization

---

