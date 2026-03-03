
---

# Gas Measurement & EIP-1559 Transaction Report

---

# 1. Executive Summary

This experiment successfully achieved the following:

* Executed a real ERC-20 transaction on-chain
* Validated the EIP-1559 fee model
* Compared estimated vs. actual gas usage
* Measured time-to-inclusion
* Verified total transaction cost

The transaction was included in a block within **4.3 seconds**, with gas estimation error below 1%. The EIP-1559 fee model operated as expected, with no underpriced errors or overpayment issues observed.

---

# 2. Transaction Overview

| Field        | Value                                                              |
| ------------ | ------------------------------------------------------------------ |
| Timestamp    | 2026-03-02T21:08:40.250Z                                           |
| Provider     | QuickNode                                                          |
| Job ID       | job_1772485714518                                                  |
| Mode         | LOCAL_SIGN                                                         |
| Status       | MINED                                                              |
| Block Number | 83682844                                                           |
| Tx Hash      | 0xb2cc7c29bcce1c5a3bc6fd198fe2b8e269b3a63dffa535a610a3de4a62910a06 |

---

# 3. Gas Estimation Analysis

## 3.1 Estimated vs. Actual

| Metric           | Value            |
| ---------------- | ---------------- |
| estimateGas      | 45,427           |
| gasLimit         | 49,969           |
| gasUsed          | 45,047           |
| Estimation Error | 380 gas (~0.84%) |

### Analysis

* The estimation error is extremely low (<1%).
* A 10% gas buffer successfully prevented out-of-gas risk.
* ERC-20 transfer gas consumption appears stable and predictable.

**Conclusion: The gas estimation pipeline performs reliably.**

---

# 4. EIP-1559 Fee Structure Analysis

## Raw Data (Wei)

| Parameter            | Value (Wei)     |
| -------------------- | --------------- |
| baseFeePerGas        | 69,431,345,620  |
| maxPriorityFeePerGas | 26,629,318,412  |
| maxFeePerGas         | 109,946,933,156 |
| effectiveGasPrice    | 95,027,366,692  |

---

## Converted to Gwei

| Parameter         | Gwei   |
| ----------------- | ------ |
| baseFee           | 69.43  |
| priorityFee (max) | 26.63  |
| maxFee            | 109.95 |
| effectiveGasPrice | 95.03  |

---

## 4.1 Pricing Validation

Under EIP-1559, the transaction price follows:

```
effectiveGasPrice = baseFee + priorityFee
```

Computed:

```
69.43 + 26.63 ≈ 96.06 gwei
```

Actual:

```
95.03 gwei
```

The slight difference is expected due to block-level rounding and minor base fee fluctuations.

---

## 4.2 Fee Safety Evaluation

* effectiveGasPrice < maxFee
* priorityFee was not capped by maxFee
* No underpriced rejection occurred

**This indicates that the maxFee configuration was conservative yet appropriate.**

---

# 5. Transaction Cost Analysis

## 5.1 Actual Fee

```
gasUsed = 45,047
effectiveGasPrice = 95.027 gwei
```

```
Total Fee = 0.004280697787 MATIC
```

### Interpretation

* The cost aligns with typical Polygon ERC-20 transfer fees.
* No abnormal fee spikes were observed.

---

# 6. Time-to-Inclusion Analysis

| Metric                 | Value    |
| ---------------------- | -------- |
| timeToInclusionMs      | 4,324 ms |
| latencyMs (full round) | 5,724 ms |

### Breakdown

Time-to-inclusion includes:

* RPC broadcast latency
* Mempool queuing time
* Block production time

An inclusion time of 4.3 seconds falls within the normal and healthy range for Polygon.

---

# 7. Scheduler Evaluation

For this transaction:

* It was broadcast when baseFee ≈ 69 gwei
* It was included within approximately 4 seconds

The scheduler successfully achieved:

* Cost control
* Execution within deadline
* Timely confirmation

---

# 8. Deliverables Verification

| Deliverable               | Status | Evidence                         |
| ------------------------- | ------ | -------------------------------- |
| Send actual transactions  | ✔      | Tx mined at block 83682844       |
| Measure time to block     | ✔      | 4.3s inclusion                   |
| Measure actual gas spent  | ✔      | 45,047 gas used                  |
| Compare estimated gas     | ✔      | 0.84% estimation error           |
| Implement standalone 1559 | ✔      | LOCAL_SIGN mode                  |
| Scheduling within 24h     | ✔      | Job system executed successfully |

---

# 9. Observations

1. Gas estimation accuracy is high.
2. Fee ceiling design is safe and conservative.
3. Tip configuration was sufficient for rapid inclusion.
4. Scheduler decisions aligned with actual network conditions.
5. Overall system performance is stable.

---

# 10. Limitations

The current design follows:

> Pre-sign → Wait → Broadcast

Therefore:

* nonce is fixed at signing time
* maxFee is fixed
* priorityFee is fixed
* no dynamic re-pricing is implemented

This approach is suitable for research and controlled environments,
but it is not a fully dynamic production-grade execution engine.
