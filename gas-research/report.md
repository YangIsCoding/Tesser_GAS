# Polygon Gas Fee Measurement and Comparative Study

## 1. Research Background

With the introduction of EIP-1559, the gas pricing mechanism evolved from the traditional:

```
gasPrice *  gasUsed
```

to the new structure:

```
( baseFee + priorityFee ) * gasUsed
```

This structural shift changes both the predictability and control of transaction costs.

Accordingly, this study aims to answer the following questions:

1. How do different RPC providers compare in performance and reliability?
2. What are the structural differences between Legacy and EIP-1559 fee models?
3. How does a conservative upper-bound model compare to the expected EIP-1559 fee?
4. Is there systematic intraday variation in gas fees?

---

## 2. Research Objectives

The core objectives of this study are:

---

### 2.1 Comparison of RPC Providers

We select three Polygon mainnet RPC providers:

* QuickNode
* Alchemy
* Dwellir

We evaluate them based on:

* Average response latency
* Error rate
* Consistency of gas-related data

---

### 2.2 Comparison of Legacy and EIP-1559 Fee Models

We analyze three fee estimation approaches:

#### A. Legacy Model

```
estimatedFee = gasPrice × estimateGas
```

#### B. EIP-1559 Expected Model

```
expectedFee1559 = (baseFee + p50_priorityFee) × estimateGas
```

#### C. EIP-1559 Conservative Upper-Bound Model

```
maxFee = baseFee × 2 + priorityFee
estimatedFee1559 = maxFee × estimateGas
```

The objective is to evaluate:

* Structural differences between Legacy and EIP-1559 models
* Whether the conservative model systematically overestimates
* Whether the expected model better approximates realistic transaction costs

---

## 3. Data Collection Design

### 3.1 Test Transaction Design

We simulate a standard ERC-20 transfer transaction:

* FROM: fixed test address
* TO: fixed recipient address
* Token: USDC on Polygon
* Amount: 1,000,000 (smallest denomination unit)

Transaction calldata is generated using:

```js
encodeFunctionData({
  abi: erc20Abi,
  functionName: 'transfer',
})
```

This ensures:

* Realistic `estimateGas` behavior
* Reproducible measurement conditions
* Identical transaction payload across all providers

---

### 3.2 Measurement Procedure

The `measureOnce()` function is executed every 10 minutes.

For each provider, the following steps are performed:

---

#### Step 1: Retrieve Legacy Data

Parallel requests:

```js
client.getGasPrice()
client.estimateGas()
```

Collected values:

* `gasPriceWei`
* `estimateGas`
* `estimatedFeeWei`

---

#### Step 2: Retrieve baseFee

Using:

```js
client.getBlock()
```

We extract:

```
baseFeePerGas
```

from the latest block.

---

#### Step 3: Retrieve Priority Fee (Tip)

Using:

```js
eth_feeHistory
```

We request the reward percentiles for the latest 5 blocks.

We select:

```
50th percentile (p50)
```

as a representative priority fee.

---

#### Step 4: Compute Three Fee Variants

1. Legacy fee
2. Expected EIP-1559 fee
3. Conservative EIP-1559 upper-bound fee

---

### 3.3 Recorded Data Fields

Each observation includes the following fields:

| Field                   | Description                  |
| ----------------------- | ---------------------------- |
| ts                      | ISO timestamp                |
| provider                | RPC provider name            |
| gasPriceWei             | Legacy gas price             |
| estimateGas             | Estimated gas usage          |
| estimatedFeeWei         | Legacy estimated fee         |
| baseFeePerGasWei        | Block base fee               |
| priorityFeeP50Wei       | p50 priority fee             |
| maxPriorityFeePerGasWei | Configured max priority fee  |
| maxFeePerGasWei         | Configured max fee           |
| expectedFee1559Wei      | Expected EIP-1559 fee        |
| estimatedFee1559Wei     | Conservative upper-bound fee |
| latencyMs               | RPC response time            |
| error                   | Error message (if any)       |

All measurements are written to:

```
gas_measurements.csv
```

---

## 4. Measurement Frequency and Time Dimension

The system is configured to:

```
Execute every 10 minutes
```

This enables analysis of:

* Hour-of-day effects
* Peak congestion periods
* Fee volatility cycles
* Provider stability over time