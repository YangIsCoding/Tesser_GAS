import 'dotenv/config'
import fs from 'node:fs'
import {
  createPublicClient,
  http,
  encodeFunctionData,
  erc20Abi,
  getAddress,
} from 'viem'
import { polygon } from 'viem/chains'

const PROVIDERS = [
  { name: 'quicknode', url: process.env.RPC_QUICKNODE },
  { name: 'alchemy', url: process.env.RPC_ALCHEMY },
  { name: 'dwellir', url: process.env.RPC_DWELLIR },
].filter((p) => !!p.url)

console.log('PROVIDERS=', PROVIDERS)

const OUT = 'gas_measurements.csv'

if (!fs.existsSync(OUT)) {
  fs.writeFileSync(
    OUT,
    [
      'ts,provider',
      'gasPriceWei,estimateGas,estimatedFeeWei',
      'baseFeePerGasWei,priorityFeeP50Wei',
      'maxPriorityFeePerGasWei,maxFeePerGasWei',
      'expectedFee1559Wei,estimatedFee1559Wei',
      'latencyMs,error',
    ].join(',') + '\n'
  )
}

const FROM = getAddress('0x2F1339db75E1Dc0cF133D61538EdE7964647ccf0')
const TO = getAddress('0xae01fcdc75bc7fec8a62f5b3dc3cffe5acd2f52b')
const TOKEN_CONTRACT = getAddress('0x2791bca1f2de4661ed88a30c99a7a9449aa84174')
const AMOUNT = 1_000_000n

function nowIso() {
  return new Date().toISOString()
}

async function measureOnce() {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [TO, AMOUNT],
  })

  for (const p of PROVIDERS) {
    const client = createPublicClient({
      chain: polygon,
      transport: http(p.url),
    })

    const t0 = Date.now()

    // legacy
    let gasPriceWei = ''
    let estimateGas = ''
    let estimatedFeeWei = ''

    // eip1559
    let baseFeePerGasWei = ''
    let priorityFeeP50Wei = ''
    let maxPriorityFeePerGasWei = ''
    let maxFeePerGasWei = ''
    let expectedFee1559Wei = ''   // ✅ NEW (base + tip) * gas
    let estimatedFee1559Wei = ''  // existing (maxFee * gas upper bound)

    let err = ''

    try {
      // 1️⃣ legacy + estimateGas
      const [gp, eg] = await Promise.all([
        client.getGasPrice(),
        client.estimateGas({
          account: FROM,
          to: TOKEN_CONTRACT,
          data,
        }),
      ])

      gasPriceWei = gp.toString()
      estimateGas = eg.toString()
      estimatedFeeWei = (gp * eg).toString()

      // 2️⃣ baseFee from latest block
      const block = await client.getBlock()
      const baseFee = block.baseFeePerGas ?? 0n
      baseFeePerGasWei = baseFee.toString()

      // 3️⃣ feeHistory: get p50 tip
      const feeHistory = await client.request({
        method: 'eth_feeHistory',
        params: ['0x5', 'latest', [50]],
      })

      const rewards = feeHistory.reward || []
      const latestReward = rewards.length
        ? rewards[rewards.length - 1][0]
        : '0x0'

      const priorityP50 = BigInt(latestReward)
      priorityFeeP50Wei = priorityP50.toString()

      // ✅ NEW: expected fee ~= (baseFee + tip) * gas
      expectedFee1559Wei = ((baseFee + priorityP50) * eg).toString()

      // simple strategy (upper bound)
      const maxPriority = priorityP50
      const maxFee = baseFee * 2n + maxPriority
      maxPriorityFeePerGasWei = maxPriority.toString()
      maxFeePerGasWei = maxFee.toString()

      // existing: conservative upper bound fee
      estimatedFee1559Wei = (maxFee * eg).toString()
    } catch (e) {
      err =
        e && e.message
          ? String(e.message).replaceAll('\n', ' ')
          : String(e)
    }

    const latencyMs = Date.now() - t0

    fs.appendFileSync(
      OUT,
      [
        nowIso(),
        p.name,
        gasPriceWei,
        estimateGas,
        estimatedFeeWei,
        baseFeePerGasWei,
        priorityFeeP50Wei,
        maxPriorityFeePerGasWei,
        maxFeePerGasWei,
        expectedFee1559Wei,   // ✅ NEW
        estimatedFee1559Wei,
        latencyMs.toString(),
        `"${err.replaceAll('"', '""')}"`,
      ].join(',') + '\n'
    )

    console.log(
      `[${p.name}] done latency=${latencyMs}ms err=${err ? 'YES' : 'NO'}`
    )
  }
}

const intervalMs = 10 * 60 * 1000
console.log(`Writing to ${OUT}. Interval=${intervalMs}ms`)

await measureOnce()
setInterval(measureOnce, intervalMs)