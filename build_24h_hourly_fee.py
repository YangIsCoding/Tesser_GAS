import json
import csv
import time
import urllib.request

RPC_URL = "https://frequent-ancient-dream.matic.quiknode.pro/33b8bf6656a36d1f0f988457b7cbcf89802db5d0/"
OUT_CSV = "polygon_hourly_fee_24h.csv"

BLOCKS_PER_CHUNK = 1024
TARGET_HOURS = 24

def rpc_call(method, params):
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params
    }).encode("utf-8")
    req = urllib.request.Request(RPC_URL, data=payload, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=60)
    data = resp.read().decode("utf-8")
    j = json.loads(data)
    return j.get("result")

def h2i(h):
    return int(h, 16)

def wei_to_gwei(x):
    return x / 1e9

def hour_bucket(ts):
    return int(ts // 3600) * 3600

def get_block_timestamp(block_number_int):
    blk = rpc_call("eth_getBlockByNumber", [hex(block_number_int), False])
    if blk is None:
        return None
    ts_hex = blk.get("timestamp")
    if ts_hex is None:
        return None
    return h2i(ts_hex)

def get_latest_block_number():
    bn_hex = rpc_call("eth_blockNumber", [])
    return h2i(bn_hex)

def fetch_fee_history_chunk(newest_block_int):
    # params: [blockCount, newestBlock, rewardPercentiles]
    res = rpc_call("eth_feeHistory", [hex(BLOCKS_PER_CHUNK), hex(newest_block_int), [50]])
    return res

# 聚合桶：hour_epoch -> [count, sum_base, sum_tip, sum_gas]
buckets = {}

latest_block = get_latest_block_number()
current_newest = latest_block

# 全局：最新时间固定为第一段 newest 的 timestamp
t_latest = None
t_oldest_so_far = None

chunk_index = 0

while True:
    chunk_index += 1

    fh = fetch_fee_history_chunk(current_newest)
    if fh is None:
        print("feeHistory returned None; stop")
        break

    oldest_block = h2i(fh["oldestBlock"])
    rewards = fh["reward"]                 # len ~1024
    base_fees = fh["baseFeePerGas"]        # len ~1025

    n = len(rewards)
    if n == 0:
        print("Empty rewards; stop")
        break

    # 段首段尾 timestamp（两次）
    seg_oldest_bn = oldest_block
    seg_newest_bn = oldest_block + (n - 1)

    ts_oldest = get_block_timestamp(seg_oldest_bn)
    ts_newest = get_block_timestamp(seg_newest_bn)

    if ts_oldest is None or ts_newest is None:
        print("timestamp missing; stop")
        break

    # 初始化全局最新时间（只做一次）
    if t_latest is None:
        t_latest = ts_newest

    # 更新全局最老时间（不断往更旧更新）
    if t_oldest_so_far is None:
        t_oldest_so_far = ts_oldest
    else:
        if ts_oldest < t_oldest_so_far:
            t_oldest_so_far = ts_oldest

    covered_hours = (t_latest - t_oldest_so_far) / 3600.0

    # 这段的跨度，用于线性插值
    span = ts_newest - ts_oldest
    if span <= 0:
        span = int((n - 1) * 2)

    # 聚合这一段
    for i in range(n):
        base_wei = h2i(base_fees[i])  # 用前 n 个
        tip_wei = 0
        if rewards[i] is not None and len(rewards[i]) > 0:
            tip_wei = h2i(rewards[i][0])

        # 段内线性插值 timestamp
        if n - 1 > 0:
            ts = ts_oldest + int(i * span / (n - 1))
        else:
            ts = ts_oldest

        hb = hour_bucket(ts)

        if hb not in buckets:
            buckets[hb] = [0, 0.0, 0.0, 0.0]

        buckets[hb][0] += 1
        buckets[hb][1] += wei_to_gwei(base_wei)
        buckets[hb][2] += wei_to_gwei(tip_wei)
        buckets[hb][3] += wei_to_gwei(base_wei + tip_wei)

    print(
        "chunk", chunk_index,
        "oldest", hex(seg_oldest_bn),
        "newest", hex(current_newest),
        "covered_hours", round(covered_hours, 2)
    )

    if covered_hours >= TARGET_HOURS:
        break

    # 下一段继续往回：从这一段的 oldest_block - 1 开始
    current_newest = oldest_block - 1

    time.sleep(0.1)

# 输出 CSV（UTC 小时）
rows = []
for hb in sorted(buckets.keys()):
    cnt, sb, st, sg = buckets[hb]
    rows.append({
        "hour_epoch": hb,
        "hour_utc": time.strftime("%Y-%m-%d %H:00:00", time.gmtime(hb)),
        "avg_base_fee_gwei": round(sb / cnt, 4),
        "avg_tip_gwei_p50": round(st / cnt, 4),
        "avg_gas_price_gwei": round(sg / cnt, 4),
        "blocks": cnt
    })

# 只保留最近 24 小时（以 t_latest 为终点）
if len(rows) > 0 and t_latest is not None:
    end_hour = hour_bucket(t_latest)
    start_hour = end_hour - 24 * 3600
    filtered = []
    for r in rows:
        if r["hour_epoch"] >= start_hour and r["hour_epoch"] <= end_hour:
            filtered.append(r)
    rows = filtered

csvf = open(OUT_CSV, "w", newline="", encoding="utf-8")
w = csv.DictWriter(csvf, fieldnames=list(rows[0].keys()) if len(rows) > 0 else [])
w.writeheader()
for r in rows:
    w.writerow(r)
csvf.close()

print("Wrote", OUT_CSV, "rows=", len(rows))
