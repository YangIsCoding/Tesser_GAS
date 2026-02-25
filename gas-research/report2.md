
# 1) Are QuickNode’s estimates good enough?

**Yes, QuickNode is sufficient for our needs.**

* **Lowest latency:** QuickNode averages approximately **284 ms**, significantly faster than Alchemy (~551 ms) and Dwellir (~2026 ms).
* **Comparable reliability:** All three providers show similar error rates (~0.67–0.68%). QuickNode does not underperform in stability.
* **Meets engineering standards for a primary RPC provider:** QuickNode delivers both speed and reliability, making it suitable as our main infrastructure layer for fee estimation and transaction submission.

---

# 2) Should we build our own gas estimator?

**No, we do not need to build a dedicated estimator service.**

**Rationale:**

* Building a standalone estimator would introduce additional operational overhead: monitoring, maintenance, backtesting, anomaly handling (e.g., congestion spikes, RPC jitter).
* The RPC already provides sufficient primitives (baseFee, feeHistory, estimateGas). We can compute fees directly within our application logic without creating a separate estimation service.

---

# 3) Should we use third-party gas trackers (e.g., Dwellir, Polygonscan)?

**No, we should not rely on third-party gas tracker services.**

* Third-party trackers are typically derived from the same on-chain data (baseFee and feeHistory). Since we already access raw RPC data directly, the marginal benefit is limited.
* Our research and product workflow require reproducibility and transparency. Pulling raw data from our RPC provider ensures consistency and verifiability.

---

# 4) Should we schedule transactions based on time of day? Is it worth it?

**Yes, scheduling is worth implementing, and the potential savings are meaningful.**

**Based on our results:**

* Cheapest hour (02:00–03:00 UTC): avg baseFee ≈ **13.4B**
* Most expensive hour (17:00–18:00 UTC): avg baseFee ≈ **302.9B**
* Extreme spread: approximately **2159% (~22× difference)**

Using a more conservative metric:

* p10 vs p90 (hour-level averages): approximately **353.94% (~4.5× difference)**

**Expected savings interpretation:**

* For delay-tolerant transactions (batch settlements, treasury transfers, backend payouts), shifting execution toward lower-fee periods can realistically reduce base fee exposure by approximately **4–5× under conservative assumptions**, and potentially more during peak congestion.
* Total savings scale proportionally with `gasUsed × baseFee difference`. The higher the transaction volume, the greater the impact.

---

# 5) Should we implement ERC-1559?

(Open-ended: reasons to adopt it and reasons to retain legacy)

## Why we should adopt EIP-1559 (maxFeePerGas / maxPriorityFeePerGas)

* **More accurate cost structure:** Polygon transactions are effectively driven by baseFee + tip dynamics. Our data shows that the expected 1559 fee is on average **113% higher than the legacy estimate**, indicating that legacy pricing systematically underestimates real cost.
* **Stronger control and predictability:**

  * `maxPriorityFeePerGas` defines our willingness to accelerate inclusion.
  * `maxFeePerGas` defines the maximum total cost we are willing to tolerate.
    This reduces the risk of stuck transactions during congestion.
* **Better support for strategic optimization:** Time-of-day scheduling and SLA-tiered pricing (cheap / normal / fast) are more naturally implemented under the 1559 model.

## Why we should retain legacy (gasPrice) as well

* **Compatibility and fallback:** Certain toolchains, provider configurations, or degraded network scenarios may still rely on legacy pricing. Maintaining legacy support ensures operational resilience.
* **Simplicity for specific use cases:** In some contexts where rough estimation is sufficient or where only gasPrice is exposed, legacy mode allows continuity.
* **Monitoring and benchmarking:** Keeping legacy calculations enables ongoing comparison against 1559 strategies to detect overpricing or overly conservative configurations.

> Our recommended approach is:
> **Adopt EIP-1559 as the primary execution path, while retaining legacy as a fallback and monitoring baseline.**

