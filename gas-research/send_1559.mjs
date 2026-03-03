import "dotenv/config";
import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  formatEther,
  formatUnits,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

/**
 * Integrated deliverables:
 * - Standalone EIP-1559 script (Viem)
 * - Build unsigned tx (copy of buildUnsignedTransaction idea, but 1559)
 * - Sign tx (if PRIVATE_KEY provided)
 * - Scheduling: accept signed tx OR produce signed tx, then send within 24h at "optimal time"
 * - Measure: time-to-inclusion, actual gas spent, estimated gas
 */

function mustEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env ${key}`);
    process.exit(1);
  }
  return v.trim();
}

function getEnv(key, fallback) {
  const v = process.env[key];
  if (v == null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

function pickChain() {
  const name = (process.env.CHAIN || "polygon").toLowerCase();
  if (name === "polygon") return polygon;
  console.error(`Unsupported CHAIN=${name}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureCsvHeader(outFile) {
  if (fs.existsSync(outFile)) return;
  fs.writeFileSync(
    outFile,
    [
      "ts,provider,jobId,mode,status",
      "estimateGas,gasLimit",
      "baseFeePerGasWei,maxPriorityFeePerGasWei,maxFeePerGasWei",
      "sentAtMs,txHash,blockNumber,timeToInclusionMs",
      "gasUsed,effectiveGasPriceWei,actualFeeWei",
      "latencyMs,error",
    ].join(",") + "\n"
  );
}

function appendCsv(outFile, row) {
  fs.appendFileSync(outFile, row.join(",") + "\n");
}

function loadQueue(queueFile) {
  if (!fs.existsSync(queueFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(queueFile, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(queueFile, queue) {
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

function getTokenDecimals(currency) {
  if (currency === "USDC") return 6;
  if (currency === "USDT") return 6;
  return 18;
}

function getContractAddress(env, currency) {
  if (currency === "USDC") return getAddress(env.USDC_ADDRESS);
  if (currency === "USDT") return getAddress(env.USDT_ADDRESS);
  throw new Error(`Unsupported currency: ${currency}`);
}

async function getEip1559Fees(publicClient) { //estimateFeesPerGas()
  // 1) baseFee
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas;
  if (baseFee == null) {
    throw new Error("baseFeePerGas not available (chain may not support EIP-1559)");
  }

  // 2) tip and maxFee
  let maxPriorityFeePerGas;
  let maxFeePerGas;

  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    maxFeePerGas = fees.maxFeePerGas;

    console.log("estimateFeesPerGas:", {
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
    });
  } catch (e) {
    console.log("estimateFeesPerGas failed:", e?.message || e);

    // Polygon-safe fallback
    maxPriorityFeePerGas = 25n * 10n ** 9n; // 25 gwei
    // upper：2*baseFee + tip
    maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

    console.log("fallback fees:", {
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
    });
  }

  return { baseFee, maxPriorityFeePerGas, maxFeePerGas };
}

/**
 * Build unsigned tx (EIP-1559)
 * Returns txRequest + meta for measurement.
 */
async function buildUnsignedTransaction1559({
  publicClient,
  env,
  walletAddress,
  toAddress,
  amount,
  currency,
}) {
  const from = getAddress(walletAddress);
  const to = getAddress(toAddress);
  const cur = currency.toUpperCase();
  const contractAddress = getContractAddress(env, cur);

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });

  const [nonce, gasEstimate, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: from }),
    publicClient.estimateGas({ account: from, to: contractAddress, data, value: 0n }),
    getEip1559Fees(publicClient),
  ]);

  const gasLimit = (gasEstimate * 110n) / 100n;

  const txRequest = {
    to: contractAddress,
    value: 0n,
    data,
    nonce,
    gas: gasLimit,
    chainId: publicClient.chain.id,
    type: "eip1559",
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
  };

  return {
    txRequest,
    meta: {
      contractAddress,
      gasEstimate,
      gasLimit,
      baseFeePerGas: fees.baseFee,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      from,
      to,
      currency: cur,
      amount,
    },
  };
}

function shouldSendNow({ baseFeeWei, nowMs, deadlineAtMs, thresholdGwei, forceBeforeMin }) {
  const thresholdWei = parseGwei(String(thresholdGwei));
  const forceWindowMs = forceBeforeMin * 60 * 1000;

  const mustSend = nowMs >= deadlineAtMs - forceWindowMs;
  if (mustSend) return true;

  if (baseFeeWei <= thresholdWei) return true;

  return false;
}

async function sendSignedAndMeasure({ publicClient, signedTx }) {
  const sentAtMs = Date.now();

  const txHash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const includedAtMs = Number(block.timestamp) * 1000;

  const timeToInclusionMs = includedAtMs - sentAtMs;
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const actualFeeWei = gasUsed * effectiveGasPrice;

  return {
    txHash,
    receipt,
    metrics: {
      sentAtMs,
      includedAtMs,
      timeToInclusionMs,
      gasUsed,
      effectiveGasPrice,
      actualFeeWei,
    },
  };
}

// ---------------- Main ----------------
async function main() {
  const providerName = "quicknode"; // you can extend to multiple providers later

  const RPC_URL = mustEnv("RPC_URL");
  const chain = pickChain();

  const env = {
    USDC_ADDRESS: mustEnv("USDC_ADDRESS"),
    USDT_ADDRESS: mustEnv("USDT_ADDRESS"),
  };

  const OUT = getEnv("OUT", "gas_measurements_1559.csv");
  const QUEUE_FILE = getEnv("QUEUE_FILE", "tx_queue.json");

  const DEADLINE_HOURS = Number(getEnv("DEADLINE_HOURS", "24"));
  const CHECK_INTERVAL_SEC = Number(getEnv("CHECK_INTERVAL_SEC", "60"));
  const BASEFEE_THRESHOLD_GWEI = BigInt(getEnv("BASEFEE_THRESHOLD_GWEI", "50"));
  const FORCE_SEND_BEFORE_DEADLINE_MIN = Number(getEnv("FORCE_SEND_BEFORE_DEADLINE_MIN", "30"));

  const FROM = getAddress(mustEnv("FROM"));
  const TO = getAddress(mustEnv("TO"));
  const CURRENCY = mustEnv("CURRENCY").toUpperCase();
  const AMOUNT = BigInt(mustEnv("AMOUNT"));

  const SIGNED_TX_HEX = getEnv("SIGNED_TX_HEX", "");
  const PRIVATE_KEY = getEnv("PRIVATE_KEY", "");

  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  });

  let walletClient = null;
  let signerAddress = null;

  if (PRIVATE_KEY) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    signerAddress = getAddress(account.address);
    walletClient = createWalletClient({
      account,
      chain,
      transport: http(RPC_URL),
    });
  }

  // Preflight
  console.log("==== Config ====");
  console.log("Chain:", chain.name);
  console.log("RPC:", RPC_URL);
  console.log("FROM:", FROM);
  console.log("TO:", TO);
  console.log("CURRENCY:", CURRENCY);
  console.log("AMOUNT raw:", AMOUNT.toString());
  console.log("DEADLINE_HOURS:", DEADLINE_HOURS);
  console.log("CHECK_INTERVAL_SEC:", CHECK_INTERVAL_SEC);
  console.log("BASEFEE_THRESHOLD_GWEI:", BASEFEE_THRESHOLD_GWEI.toString());
  console.log("FORCE_SEND_BEFORE_DEADLINE_MIN:", FORCE_SEND_BEFORE_DEADLINE_MIN);

  // Queue bootstrap: if empty, enqueue a job (Mode A or Mode B)
  const queue = loadQueue(QUEUE_FILE);

  if (queue.length === 0) {
    // Build meta (estimateGas etc.) regardless, for measurement columns
    const built = await buildUnsignedTransaction1559({
      publicClient,
      env,
      walletAddress: FROM,
      toAddress: TO,
      amount: AMOUNT,
      currency: CURRENCY,
    });

    const decimals = getTokenDecimals(CURRENCY);
    console.log("\n==== Preflight balances ====");
    const nativeBal = await publicClient.getBalance({
      address: signerAddress ? signerAddress : FROM,
    });

    const tokenBal = await publicClient.readContract({
      address: built.meta.contractAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [signerAddress ? signerAddress : FROM],
    });

    console.log(`${chain.nativeCurrency.symbol} balance:`, formatEther(nativeBal));
    console.log(`${CURRENCY} balance:`, formatUnits(tokenBal, decimals));
    console.log(`${CURRENCY} transfer:`, formatUnits(AMOUNT, decimals));

    let mode = "";
    let signedTx = "";

    if (SIGNED_TX_HEX) {
      mode = "SIGNED_TX_ENV";
      signedTx = SIGNED_TX_HEX;
      console.log("\nEnqueue Mode A: using SIGNED_TX_HEX from env");
    } else {
      if (!walletClient) {
        console.error(
          "Queue is empty but neither SIGNED_TX_HEX nor PRIVATE_KEY is provided.\n" +
            "Provide SIGNED_TX_HEX (Mode A) OR PRIVATE_KEY (Mode B)."
        );
        process.exit(1);
      }
      mode = "LOCAL_SIGN";
      console.log("\nEnqueue Mode B: signing inside script using PRIVATE_KEY");
      signedTx = await walletClient.signTransaction(built.txRequest);
    }

    const createdAtMs = Date.now();
    const deadlineAtMs = createdAtMs + DEADLINE_HOURS * 60 * 60 * 1000;

    const job = {
      id: `job_${createdAtMs}`,
      mode,
      provider: providerName,
      status: "PENDING",
      createdAtMs,
      deadlineAtMs,
      signedTx,
      // store measurement baselines
      estimateGas: built.meta.gasEstimate.toString(),
      gasLimit: built.meta.gasLimit.toString(),
      baseFeePerGasWeiAtBuild: built.meta.baseFeePerGas.toString(),
      maxPriorityFeePerGasWeiAtBuild: built.meta.maxPriorityFeePerGas.toString(),
      maxFeePerGasWeiAtBuild: built.meta.maxFeePerGas.toString(),
      currency: CURRENCY,
      amount: AMOUNT.toString(),
      from: built.meta.from,
      to: built.meta.to,
      contract: built.meta.contractAddress,
    };

    saveQueue(QUEUE_FILE, [job]);
    console.log("Enqueued job:", job.id);
    console.log("Job deadline:", new Date(deadlineAtMs).toISOString());
  }

  ensureCsvHeader(OUT);

  console.log(`\n==== Scheduler started. Queue=${QUEUE_FILE}, CSV=${OUT} ====`);
  console.log("Will check optimal time and send within deadline.\n");

  async function tick() {
    const t0 = Date.now();
    let err = "";
    let latencyMs = 0;

    const q = loadQueue(QUEUE_FILE);
    if (q.length === 0) {
      console.log(`[${nowIso()}] queue empty; nothing to do.`);
      return;
    }

    const job = q[0];
    if (job.status !== "PENDING") {
      console.log(`[${nowIso()}] job ${job.id} status=${job.status}; nothing to do.`);
      return;
    }

    const nowMs = Date.now();

    // Deadline check
    if (nowMs > job.deadlineAtMs) {
      job.status = "EXPIRED";
      saveQueue(QUEUE_FILE, q);
      console.log(`[${nowIso()}] job ${job.id} expired.`);
      appendCsv(OUT, [
        nowIso(),
        providerName,
        job.id,
        job.mode,
        job.status,
        job.estimateGas,
        job.gasLimit,
        "", // baseFee now
        "", // maxPriority now
        "", // maxFee now
        "", // sentAt
        "", // txHash
        "", // blockNumber
        "", // inclusion
        "", // gasUsed
        "", // eff gas price
        "", // actual fee
        "0",
        `"expired"`,
      ]);
      return;
    }

    // Read current fees to decide optimal time
    let baseFeeNow = 0n;
    let maxPriorityNow = 0n;
    let maxFeeNow = 0n;

    try {
      const feesNow = await getEip1559Fees(publicClient);
      baseFeeNow = feesNow.baseFee;
      maxPriorityNow = feesNow.maxPriorityFeePerGas;
      maxFeeNow = feesNow.maxFeePerGas;

      const okToSend = shouldSendNow({
        baseFeeWei: baseFeeNow,
        nowMs,
        deadlineAtMs: job.deadlineAtMs,
        thresholdGwei: BASEFEE_THRESHOLD_GWEI,
        forceBeforeMin: FORCE_SEND_BEFORE_DEADLINE_MIN,
      });

      if (!okToSend) {
        latencyMs = Date.now() - t0;
        console.log(
          `[${nowIso()}] job=${job.id} NOT optimal yet. baseFeeWei=${baseFeeNow.toString()} thresholdGwei=${BASEFEE_THRESHOLD_GWEI.toString()}`
        );

        // log a “check” row (optional but useful)
        appendCsv(OUT, [
          nowIso(),
          providerName,
          job.id,
          job.mode,
          "CHECKED",
          job.estimateGas,
          job.gasLimit,
          baseFeeNow.toString(),
          maxPriorityNow.toString(),
          maxFeeNow.toString(),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          latencyMs.toString(),
          `""`,
        ]);
        return;
      }

      // Send
      const result = await sendSignedAndMeasure({
        publicClient,
        signedTx: job.signedTx,
      });

      job.status = "MINED";
      job.txHash = result.txHash;
      job.sentAtMs = result.metrics.sentAtMs;
      job.includedAtMs = result.metrics.includedAtMs;
      job.timeToInclusionMs = result.metrics.timeToInclusionMs;
      job.blockNumber = result.receipt.blockNumber.toString();
      job.gasUsed = result.metrics.gasUsed.toString();
      job.effectiveGasPriceWei = result.metrics.effectiveGasPrice.toString();
      job.actualFeeWei = result.metrics.actualFeeWei.toString();

      saveQueue(QUEUE_FILE, q);

      latencyMs = Date.now() - t0;

      console.log(
        `[${nowIso()}] job=${job.id} SENT+MINED tx=${result.txHash} inclusionMs=${result.metrics.timeToInclusionMs}`
      );

      appendCsv(OUT, [
        nowIso(),
        providerName,
        job.id,
        job.mode,
        job.status,
        job.estimateGas,
        job.gasLimit,
        baseFeeNow.toString(),
        maxPriorityNow.toString(),
        maxFeeNow.toString(),
        String(result.metrics.sentAtMs),
        result.txHash,
        result.receipt.blockNumber.toString(),
        String(result.metrics.timeToInclusionMs),
        result.metrics.gasUsed.toString(),
        result.metrics.effectiveGasPrice.toString(),
        result.metrics.actualFeeWei.toString(),
        latencyMs.toString(),
        `""`,
      ]);
    } catch (e) {
      err = e && e.message ? String(e.message).replaceAll("\n", " ") : String(e);
      latencyMs = Date.now() - t0;

      // mark failed (you can choose to keep PENDING instead)
      const q2 = loadQueue(QUEUE_FILE);
      if (q2.length > 0) {
        q2[0].status = "FAILED";
        q2[0].error = err;
        saveQueue(QUEUE_FILE, q2);
      }

      console.log(`[${nowIso()}] job FAILED err=${err}`);

      appendCsv(OUT, [
        nowIso(),
        providerName,
        q[0]?.id || "",
        q[0]?.mode || "",
        "FAILED",
        q[0]?.estimateGas || "",
        q[0]?.gasLimit || "",
        baseFeeNow.toString(),
        maxPriorityNow.toString(),
        maxFeeNow.toString(),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        latencyMs.toString(),
        `"${err.replaceAll('"', '""')}"`,
      ]);
    }
  }

  // Run immediately, then interval
  await tick();
  setInterval(tick, CHECK_INTERVAL_SEC * 1000);
}

main().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});