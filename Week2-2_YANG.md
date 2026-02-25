# Tesser – Gas Estimation Overview

## 1️⃣ What Is Happening When We Estimate Gas?

In EVM-based chains (Ethereum / Base / Polygon), gas estimation has **two separate components**:

---

### A. Gas Limit (How much gas the transaction will consume)

Flow:

1. Construct transaction payload (`to`, `data`, `value`)
2. Call RPC:

   ```
   eth_estimateGas
   ```
3. The node simulates execution (not broadcasted) and returns estimated gas usage.

QuickNode documentation:
[https://www.quicknode.com/docs/ethereum/eth_estimateGas](https://www.quicknode.com/docs/ethereum/eth_estimateGas)

Best practice: add a safety buffer

```
gasLimit = estimatedGas × 1.1~1.3
```

---

### B. Gas Fees (How much we pay per unit gas)

Two models:

**Legacy**

```
eth_gasPrice
```

[https://www.quicknode.com/docs/ethereum/eth_gasPrice](https://www.quicknode.com/docs/ethereum/eth_gasPrice)

**EIP-1559**

* `maxFeePerGas`
* `maxPriorityFeePerGas`

```
eth_maxPriorityFeePerGas
```

[https://www.quicknode.com/docs/ethereum/eth_maxPriorityFeePerGas](https://www.quicknode.com/docs/ethereum/eth_maxPriorityFeePerGas)

---

## 2️⃣ Does QuickNode Provide Utilities We Can Leverage?

Beyond standard RPC, QuickNode offers:

**Gas Price Estimator (Functions Library)**
[https://www.quicknode.com/docs/functions/functions-library/gas-price-estimator](https://www.quicknode.com/docs/functions/functions-library/gas-price-estimator)

**Gold Rush Gas Price Tiers (slow / avg / fast)**
[https://www.quicknode.com/docs/base/goldrush-wallet-api/v1-chainName-event-eventType-gas_prices](https://www.quicknode.com/docs/base/goldrush-wallet-api/v1-chainName-event-eventType-gas_prices)

These can help with:

* Fee tier strategies
* Monitoring gas market conditions
* Building internal pricing logic

---

## 3️⃣ MEV Consideration

Gas estimation reduces failed transactions and overpayment.

However, MEV exposure depends on:

* Public mempool broadcasting
* Priority fee settings
* Whether private relays or bundles are used

Gas estimation does not eliminate MEV risk.

