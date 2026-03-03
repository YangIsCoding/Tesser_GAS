
# Deliverables Technical Documentation (Focused on the Three Core Items)

## Background and Objective

We aim to upgrade the gas analysis process from pure RPC-based estimation to a **real on-chain execution measurement pipeline**, with the following goals:

* Construct transactions using the **EIP-1559 fee model** (via Viem)
* Support both local signing and externally signed transactions
* Schedule transactions within 24 hours, broadcasting during low baseFee periods
* Generate analyzable datasets (CSV) for:

  * Estimated vs. actual gas comparison
  * Time-to-inclusion measurement
  * Cost and latency comparison across providers, time windows, and threshold configurations

---

# 1) Modify Gas Analysis Process

## 1.1 Execute Real Transactions On-Chain and Measure Three Core Metrics

---

## A. Estimated Gas Amount

When building the unsigned transaction, the script estimates the gas required for an ERC-20 transfer:

* First, construct calldata:

```js
data = encodeFunctionData(transfer(to, amount))
```

* Then call:

```js
publicClient.estimateGas({
  account: from,
  to: contractAddress,
  data,
  value: 0n
})
```

This returns:

* `gasEstimate`: the predicted gas usage.

A safety buffer is applied:

```js
gasLimit = gasEstimate * 1.10
```

This helps prevent out-of-gas failures.

---

## B. Actual Gas Spent

After broadcasting the transaction, the receipt is retrieved:

```js
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
```

From the receipt:

* `receipt.gasUsed`: actual gas consumed
* `receipt.effectiveGasPrice`: final EIP-1559 transaction price (Wei)

The actual fee paid is computed as:

```js
actualFeeWei = gasUsed * effectiveGasPrice
```

This provides the true on-chain cost of execution.

---

## C. Time for Transaction to Be Added to a Block

Time-to-inclusion is defined using two timestamps:

1. Local send time:

```js
sentAtMs = Date.now()
sendRawTransaction(...)
```

2. Block inclusion time (on-chain):

* Retrieve `blockNumber` from the receipt
* Then fetch the block:

```js
const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
includedAtMs = Number(block.timestamp) * 1000
```

Finally:

```js
timeToInclusionMs = includedAtMs - sentAtMs
```

This metric includes:

* RPC broadcast latency
* Mempool propagation delay
* Waiting time before block inclusion
* Block timestamp granularity (seconds)

---

## D. Data Persistence

Results are written to CSV:

* At transaction build time (baseline):

  * estimateGas
  * gasLimit
  * baseFee / tip / maxFee
* During scheduler checks:

  * status = CHECKED
  * baseFeeNow / maxFeeNow
* After successful mining:

  * status = MINED
  * txHash / blockNumber
  * timeToInclusion
  * gasUsed
  * effectiveGasPrice
  * actualFee

This produces a structured dataset for further analysis.

---

# 2) Standalone Script Implementing EIP-1559

---

## 2.1 Copy buildUnsignedTransaction (Using Viem)

`buildUnsignedTransaction1559()` serves as the EIP-1559 version of the original `buildUnsignedTransaction`, returning a `txRequest` containing:

* ERC-20 transfer calldata
* nonce (`getTransactionCount`)
* gas (estimate + 10% buffer)
* EIP-1559 fee parameters:

  * maxPriorityFeePerGas
  * maxFeePerGas
* type: `"eip1559"`

---

## 2.2 Add Logic to Sign Transaction

Two signing strategies are supported:

### Mode A: Externally Signed

* `SIGNED_TX_HEX` provided via environment variables
* Script does not access private keys

### Mode B: Local Private Key Signing

* `PRIVATE_KEY` provided via environment variables
* Transaction signed via:

```js
walletClient.signTransaction(txRequest)
```

This design supports both research and custody-friendly execution.

---

## 2.3 Send Transaction On-Chain

Transactions are broadcast using:

```js
publicClient.sendRawTransaction({ serializedTransaction: signedTx })
```

Then confirmation is awaited:

```js
waitForTransactionReceipt
```

---

# 3) Scheduling Function

---

## 3.1 Accept Signed Transaction

Signed transaction sources are abstracted into a unified format:

* Stored as `job.signedTx`
* Scheduler logic does not differentiate signing source
* Only determines when to broadcast

---

## 3.2 24-Hour Deadline (Hard Constraint)

At enqueue time:

```js
deadlineAtMs = createdAtMs + DEADLINE_HOURS * 60 * 60 * 1000
```

Default: 24 hours.

During each scheduler tick:

* If current time exceeds deadline → mark as EXPIRED (no broadcast)

---

## 3.3 Optimal Time (Cost Optimization Policy)

Optimal conditions are defined as:

* `baseFee <= threshold` (e.g., 150 gwei), or
* Within the force-send window before deadline (`forceBeforeMin`)

Decision function:

```js
shouldSendNow({
  baseFeeWei,
  deadlineAtMs,
  thresholdGwei,
  forceBeforeMin
})
```

Behavior:

* If not optimal → record CHECKED row and wait
* If optimal → execute `sendSignedAndMeasure`

---

## 3.4 Scheduler Execution Model

* `await tick()` executes once immediately
* `setInterval(tick, CHECK_INTERVAL_SEC * 1000)` runs every 60 seconds

---

## 3.5 Important Limitations

The current design follows:

> **Pre-sign → Wait → Broadcast**

This implies:

* `nonce` is fixed at signing time
* `maxFeePerGas` is fixed
* `maxPriorityFeePerGas` is fixed
* Scheduler retrieves updated fees only for decision-making, not for repricing

If baseFee changes significantly during the waiting period:

* The transaction may be overly conservative (high maxFee ceiling)
* It may become underpriced (if priority fee is too low)
* Optimal timing logic may diverge from actual inclusion behavior (since priority fee heavily affects inclusion speed)

This design satisfies the deliverable requirement (“accept a signed transaction and schedule it”), but it is not a fully dynamic re-pricing execution engine.
