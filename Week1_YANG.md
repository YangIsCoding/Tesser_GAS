
## 0) Background & Objective

**Objective**
I used **QuickNode’s Polygon RPC** to pull raw on-chain gas data, aggregate it to an **hourly level**, and visualize it in **Retool** to support:

* Time-based trends (by time period / time of day)
* Identification of gas **outliers** and comparison against on-chain averages

**Current status**
At this stage, we do not yet have Tesser’s own production transactions. Therefore, I first established an **on-chain gas baseline (fee environment)** using Polygon network data, which can later be extended to incorporate Tesser’s internal transactions.

---

## 1) QuickNode RPC Connectivity Test

### 1.1 Query latest block number (`eth_blockNumber`)

I first verified that the QuickNode Polygon RPC endpoint was working by querying the latest block number:

```bash
curl --location 'https://frequent-ancient-dream.matic.quiknode.pro/33b8bf6656a36d1f0f988457b7cbcf89802db5d0/' \
--header 'Content-Type: application/json' \
--data '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}'
```

**Result observed:**

```json
{"jsonrpc":"2.0","id":1,"result":"0x4ef1f7e"}
```

This confirmed that the RPC endpoint was reachable and responding correctly.

---

## 2) Fetching Polygon Gas Data via `eth_feeHistory`

### 2.1 Fetch a single fee history window (~1024 blocks)

I then used `eth_feeHistory` to retrieve Polygon gas data, including base fees and priority fees.

> **Important note:**
> Through experimentation, I confirmed that **QuickNode limits `eth_feeHistory` responses to ~1024 blocks per request**.

```bash
curl --location 'https://frequent-ancient-dream.matic.quiknode.pro/33b8bf6656a36d1f0f988457b7cbcf89802db5d0/' \
--header 'Content-Type: application/json' \
--data '{
  "jsonrpc":"2.0",
  "id":10,
  "method":"eth_feeHistory",
  "params":[
    "0x2a30",
    "latest",
    [50]
  ]
}' > fee_history.json
```

From this request, I successfully retrieved:

* `reward` (p50 priority fee / tip)
* `baseFeePerGas`
* `gasUsedRatio`

---

### 2.2 Verifying JSON structure and array lengths

I verified the structure and sizes of the returned arrays:

```bash
python3 -c "import json; d=json.load(open('fee_history.json')); r=d['result']; print('keys=', list(r.keys())); print('oldestBlock=', r.get('oldestBlock')); print('len(baseFeePerGas)=', len(r.get('baseFeePerGas', []))); print('len(reward)=', len(r.get('reward', [])))"
```

**Observed output:**

* `len(baseFeePerGas) = 1025`
* `len(reward) = 1024`

This confirmed the 1024-block effective cap and explained why only a limited time window was covered per request.

---

## 3) Generating an Hourly CSV (Single-Chunk Version)

I first implemented a simple aggregation pipeline that processes **a single `fee_history.json` file** and converts block-level gas data into **hourly averages**.

This script was used to generate my initial CSV (covering ~2 hours).

* Script file: `make_hourly_fee_csv.py`
* Output: `polygon_hourly_fee.csv`

This validated the end-to-end flow:
**QuickNode → block-level gas → hourly aggregation → CSV output**.

---

## 4) Key Engineering Step: Overcoming the 1024-Block Limit with Chunking

I demonstrated that:

* Every `eth_feeHistory` call always returns `len(reward) = 1024`
* Therefore, retrieving **24 hours of data** requires **multiple RPC calls**

### Approach

To obtain a full 24-hour window, I implemented a **chunking strategy**:

* Repeatedly call `eth_feeHistory` with a 1024-block window
* Walk backward in time chunk by chunk
* For each chunk:

  * Fetch timestamps for the oldest and newest block
  * Linearly interpolate timestamps within the chunk
* Accumulate coverage until total time span ≥ 24 hours
* Aggregate all data into hourly buckets

### Implementation

* Script file: `build_24h_hourly_fee.py`
* Output file: `polygon_hourly_fee_24h.csv`

### Result

* Final coverage: **~24.46 hours**
* Output rows: **25 hourly data points**

```text
polygon_hourly_fee_24h.csv rows = 25
```

---

## 5) Outlier Detection and Analysis

### 5.1 Computing p90 / p95 / max gas prices

I calculated percentile thresholds on the hourly average gas prices:

```bash
python3 -c "
import csv
xs=[]
f=open('polygon_hourly_fee_24h.csv','r')
r=csv.DictReader(f)
for row in r:
    xs.append(float(row['avg_gas_price_gwei']))
f.close()
xs=sorted(xs)
n=len(xs)
p90=xs[int(0.90*(n-1))]
p95=xs[int(0.95*(n-1))]
print('n=',n,'p90=',p90,'p95=',p95,'max=',xs[-1])
"
```

**Results:**

* `n = 25`
* `p90 = 879.8391 gwei`
* `p95 = 912.7745 gwei`
* `max = 1005.1161 gwei`

---

### 5.2 Identifying outlier hours (≥ p95)

Using `p95` as the outlier threshold, I extracted all hourly buckets exceeding that level:

```bash
python3 -c "
import csv
rows=[]
f=open('polygon_hourly_fee_24h.csv','r')
r=csv.DictReader(f)
for row in r:
    rows.append(row)
f.close()

xs=sorted([float(x['avg_gas_price_gwei']) for x in rows])
p95=xs[int(0.95*(len(xs)-1))]

outs=[x for x in rows if float(x['avg_gas_price_gwei'])>=p95]
outs=sorted(outs, key=lambda x: float(x['avg_gas_price_gwei']), reverse=True)

print('p95=',p95,'outliers=',len(outs))
for x in outs:
    print(x['hour_utc'], 'gas=', x['avg_gas_price_gwei'], 'base=', x['avg_base_fee_gwei'], 'tip=', x['avg_tip_gwei_p50'])
"
```

**Outliers identified (3 hours):**

* **2026-02-10 13:00 UTC**

  * gas = 1005.1161 gwei
  * base = 793.2588 gwei
  * tip = 211.8572 gwei

* **2026-02-10 06:00 UTC**

  * gas = 914.6631 gwei
  * base = 624.4622 gwei
  * tip = 290.2009 gwei

* **2026-02-10 14:00 UTC**

  * gas = 912.7745 gwei
  * base = 759.1795 gwei
  * tip = 153.5949 gwei

This breakdown shows that some gas spikes were primarily **base-fee-driven**, while others were driven more heavily by **priority fees**.

