import fs from 'node:fs'

const FILE = 'gas_measurements.csv'

if (!fs.existsSync(FILE)) {
  console.error('gas_measurements.csv not found')
  process.exit(1)
}

function avg(arr) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function bigintAvg(arr) {
  if (!arr.length) return 0n
  return arr.reduce((a, b) => a + b, 0n) / BigInt(arr.length)
}

function pctDiffBigInt(high, low) {
  if (low === 0n) return Infinity
  return Number((high - low) * 10000n / low) / 100
}

function isOkRow(r) {
  // Treat "", '""', whitespace as no error
  if (r.error === undefined || r.error === null) return true
  const e = String(r.error).trim()
  return e === '' || e === '""'
}

function sortBigIntAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function hourLabelUTC(h) {
  const hh = String(h).padStart(2, '0')
  const next = String((h + 1) % 24).padStart(2, '0')
  return `${hh}:00–${next}:00 UTC`
}

// ---------- load + parse ----------
const rawLines = fs.readFileSync(FILE, 'utf8').trim().split('\n')
if (rawLines.length <= 1) {
  console.error('gas_measurements.csv has no data rows')
  process.exit(1)
}

rawLines.shift() // remove header

const rows = rawLines
  .map((line, idx) => {
    const parts = line.split(',')

    // Basic guard: skip totally malformed lines
    if (parts.length < 12) return null

    const ts = new Date(parts[0])
    // If date is invalid, skip row
    if (Number.isNaN(ts.getTime())) return null

    const provider = parts[1] || ''

    // NOTE: BigInt('') throws, so we coerce carefully
    const bi = (v) => {
      const s = (v ?? '').toString().trim()
      if (!s) return 0n
      // If it's not a valid integer string, return 0n (avoid crashing)
      // Accept optional leading +/-
      if (!/^[+-]?\d+$/.test(s)) return 0n
      return BigInt(s)
    }

    const num = (v) => {
      const s = (v ?? '').toString().trim()
      if (!s) return 0
      const n = Number(s)
      return Number.isFinite(n) ? n : 0
    }

    return {
      ts,
      provider,
      gasPrice: bi(parts[2]),
      estimateGas: bi(parts[3]),
      estimatedFeeLegacy: bi(parts[4]),
      baseFee: bi(parts[5]),
      priority: bi(parts[6]),
      maxPriority: bi(parts[7]),
      maxFee: bi(parts[8]),
      expected1559: bi(parts[9]),
      estimated1559: bi(parts[10]),
      latency: num(parts[11]),
      error: parts[12] ?? ''
    }
  })
  .filter(Boolean)

// ---------- PROVIDER COMPARISON ----------
console.log('\n==============================')
console.log('PROVIDER COMPARISON')
console.log('==============================')

const providers = [...new Set(rows.map(r => r.provider).filter(Boolean))].sort()

for (const p of providers) {
  const pr = rows.filter(r => r.provider === p)
  const prOk = pr.filter(isOkRow)

  const avgLatencyAll = avg(pr.map(r => r.latency))
  const avgLatencyOk = avg(prOk.map(r => r.latency))

  const errorCount = pr.length - prOk.length
  const errorRate = pr.length ? errorCount / pr.length : 0

  console.log(`\nProvider: ${p}`)
  console.log(`  Samples: ${pr.length}`)
  console.log(`  OK samples: ${prOk.length}`)
  console.log(`  Avg latency (all): ${avgLatencyAll.toFixed(1)} ms`)
  console.log(`  Avg latency (ok): ${avgLatencyOk.toFixed(1)} ms`)
  console.log(`  Error rate: ${(errorRate * 100).toFixed(2)}%`)
}

// ---------- LEGACY vs ERC-1559 ----------
console.log('\n==============================')
console.log('LEGACY vs ERC-1559')
console.log('==============================')

const okRows = rows.filter(isOkRow)

const legacyFees = okRows.map(r => r.estimatedFeeLegacy)
const expected1559 = okRows.map(r => r.expected1559)

const avgLegacy = bigintAvg(legacyFees)
const avg1559 = bigintAvg(expected1559)

console.log(`OK rows used: ${okRows.length}/${rows.length}`)
console.log(`Avg Legacy Fee: ${avgLegacy}`)
console.log(`Avg 1559 Fee (expected): ${avg1559}`)

const legacyDiff = pctDiffBigInt(avg1559, avgLegacy)
console.log(`Difference: ${Number.isFinite(legacyDiff) ? legacyDiff.toFixed(2) + '%' : 'Infinity (avgLegacy is 0)'}`)

// ---------- TIME OF DAY ANALYSIS (baseFee) ----------
console.log('\n==============================')
console.log('TIME OF DAY ANALYSIS (baseFee)')
console.log('QuickNode only, cheapest vs most expensive hours (UTC)')
console.log('==============================')

const quicknodeRows = okRows.filter(r => r.provider === 'quicknode')

if (!quicknodeRows.length) {
  console.log('No valid QuickNode samples to analyze (check provider name or error formatting).')
  console.log('\n==============================')
  console.log('KEY INSIGHTS')
  console.log('==============================')
  process.exit(0)
}

// group baseFee by UTC hour
const byHour = {}
for (const r of quicknodeRows) {
  const hour = r.ts.getUTCHours()
  if (!byHour[hour]) byHour[hour] = []
  byHour[hour].push(r.baseFee)
}

// build hourly stats
const hourStats = []
for (const hStr of Object.keys(byHour)) {
  const h = Number(hStr)
  const fees = byHour[h]
  if (!fees.length) continue

  const avgFee = bigintAvg(fees)
  const minFee = fees.reduce((m, x) => (x < m ? x : m), fees[0])
  const maxFee = fees.reduce((m, x) => (x > m ? x : m), fees[0])

  hourStats.push({
    hourUTC: h,
    samples: fees.length,
    avgBaseFee: avgFee,
    minBaseFee: minFee,
    maxBaseFee: maxFee,
  })
}

if (!hourStats.length) {
  console.log('No hourly buckets produced (unexpected).')
  console.log('\n==============================')
  console.log('KEY INSIGHTS')
  console.log('==============================')
  process.exit(0)
}

// sort by avg baseFee asc
hourStats.sort((a, b) => sortBigIntAsc(a.avgBaseFee, b.avgBaseFee))

const TOP_N = Math.min(5, hourStats.length)

console.log(`\nCheapest hours (by avg baseFee):`)
for (let i = 0; i < TOP_N; i++) {
  const s = hourStats[i]
  console.log(
    `  #${i + 1} ${hourLabelUTC(s.hourUTC)} | avg=${s.avgBaseFee} | samples=${s.samples} | min=${s.minBaseFee} | max=${s.maxBaseFee}`
  )
}

console.log(`\nMost expensive hours (by avg baseFee):`)
for (let i = 0; i < TOP_N; i++) {
  const s = hourStats[hourStats.length - 1 - i]
  console.log(
    `  #${i + 1} ${hourLabelUTC(s.hourUTC)} | avg=${s.avgBaseFee} | samples=${s.samples} | min=${s.minBaseFee} | max=${s.maxBaseFee}`
  )
}

// p10/p90 based on hour-level averages
const hourlyAverages = hourStats.map(s => s.avgBaseFee).sort(sortBigIntAsc)

const p10Index = Math.floor(hourlyAverages.length * 0.1)
const p90Index = Math.floor(hourlyAverages.length * 0.9)

const p10 = hourlyAverages[Math.min(p10Index, hourlyAverages.length - 1)]
const p90 = hourlyAverages[Math.min(p90Index, hourlyAverages.length - 1)]

const pct = pctDiffBigInt(p90, p10)

console.log(`\nHourly avg baseFee percentiles (based on hour-level averages):`)
console.log(`  p10 hourly avg baseFee: ${p10}`)
console.log(`  p90 hourly avg baseFee: ${p90}`)
console.log(`  p10 vs p90 difference: ${Number.isFinite(pct) ? pct.toFixed(2) + '%' : 'Infinity (p10 is 0)'}`)

// ---------- KEY INSIGHTS ----------
console.log('\n==============================')
console.log('KEY INSIGHTS')
console.log('==============================')

// Simple insight lines you can expand later:
const cheapest = hourStats[0]
const expensive = hourStats[hourStats.length - 1]

console.log(`QuickNode cheapest hour (UTC): ${hourLabelUTC(cheapest.hourUTC)} avg baseFee=${cheapest.avgBaseFee} (n=${cheapest.samples})`)
console.log(`QuickNode most expensive hour (UTC): ${hourLabelUTC(expensive.hourUTC)} avg baseFee=${expensive.avgBaseFee} (n=${expensive.samples})`)
console.log(`Spread (most vs least, by avg): ${pctDiffBigInt(expensive.avgBaseFee, cheapest.avgBaseFee).toFixed(2)}%`)