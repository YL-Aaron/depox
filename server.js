const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const CACHE_TTL_MS = Number(process.env.EXCHANGE_STATUS_CACHE_TTL_MS || 10000);
const statusCache = new Map();

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/exchange-status") {
      const symbol = sanitizeSymbol(url.searchParams.get("symbol") || "USDT");
      const data = await getExchangeStatuses(symbol);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(data));
      return;
    }

    const filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    serveFile(path.join(ROOT, filePath), res);
  })
  .listen(PORT, () => {
    console.log(`充值提币状态服务已启动: http://localhost:${PORT}`);
  });

function serveFile(filePath, res) {
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": filePath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8"
    });
    res.end(content);
  });
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function getExchangeStatuses(symbol) {
  const cached = getCachedStatus(symbol);
  if (cached) {
    return cached;
  }

  const tasks = [
    withExchangeError("Gate", symbol, fetchGate(symbol)),
    withExchangeError("Bitget", symbol, fetchBitget(symbol)),
    withExchangeError("Binance", symbol, fetchBinance(symbol)),
    withExchangeError("Bybit", symbol, fetchBybit(symbol)),
    withExchangeError("OKX", symbol, fetchOkx(symbol))
  ];
  const rows = (await Promise.all(tasks)).flat();

  const result = {
    symbol,
    updatedAt: formatDateTime(new Date()),
    rows: rows.sort((a, b) => `${a.exchange}${a.network}`.localeCompare(`${b.exchange}${b.network}`))
  };

  setCachedStatus(symbol, result);
  return result;
}

async function withExchangeError(exchange, symbol, promise) {
  try {
    return await promise;
  } catch (error) {
    return [
      {
        exchange,
        symbol,
        network: "查询失败",
        depositStatus: "unknown",
        withdrawStatus: "unknown",
        updatedAt: formatDateTime(new Date()),
        note: error.message || "接口请求失败"
      }
    ];
  }
}

async function fetchGate(symbol) {
  const data = await getJson(`https://api.gateio.ws/api/v4/spot/currencies/${symbol}`);
  const chains = Array.isArray(data.chains) && data.chains.length
    ? data.chains
    : [{ name: data.chain || symbol, deposit_disabled: data.deposit_disabled, withdraw_disabled: data.withdraw_disabled }];

  return chains.map((chain) => ({
    exchange: "Gate",
    symbol,
    network: normalizeNetwork(chain.name),
    depositStatus: chain.deposit_disabled ? "closed" : "open",
    withdrawStatus: chain.withdraw_disabled || chain.withdraw_delayed ? "closed" : "open",
    updatedAt: formatDateTime(new Date()),
    note: chain.withdraw_delayed ? "提现延迟" : ""
  }));
}

async function fetchBitget(symbol) {
  const data = await getJson(`https://api.bitget.com/api/v2/spot/public/coins?coin=${encodeURIComponent(symbol)}`);
  if (data.code !== "00000") throw new Error(data.msg || "Bitget request failed");

  const coin = (data.data || []).find((item) => item.coin === symbol);
  if (!coin) return [];

  return (coin.chains || []).map((chain) => ({
    exchange: "Bitget",
    symbol,
    network: normalizeNetwork(chain.chain),
    depositStatus: toBoolean(chain.rechargeable) ? "open" : "closed",
    withdrawStatus: toBoolean(chain.withdrawable) ? "open" : "closed",
    updatedAt: formatDateTime(new Date()),
    note: chain.congestion && chain.congestion !== "normal" ? `网络${chain.congestion}` : ""
  }));
}

async function fetchBinance(symbol) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;

  if (!apiKey || !secret) {
    return [authRequiredRow("Binance", symbol, "配置 BINANCE_API_KEY / BINANCE_API_SECRET 后可查询")];
  }

  const timestamp = await getBinanceServerTime();
  const query = `timestamp=${timestamp}&recvWindow=10000`;
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
  const data = await getJson(`https://api.binance.com/sapi/v1/capital/config/getall?${query}&signature=${signature}`, {
    "X-MBX-APIKEY": apiKey
  });

  const coin = (data || []).find((item) => item.coin === symbol);
  if (!coin) return [];

  return (coin.networkList || []).map((network) => ({
    exchange: "Binance",
    symbol,
    network: normalizeNetwork(network.network || network.name),
    depositStatus: network.depositEnable ? "open" : "closed",
    withdrawStatus: network.withdrawEnable ? "open" : "closed",
    updatedAt: formatDateTime(new Date()),
    note: network.busy ? "网络繁忙" : ""
  }));
}

async function getBinanceServerTime() {
  const data = await getJson("https://api.binance.com/api/v3/time");
  return data.serverTime || Date.now();
}

async function fetchBybit(symbol) {
  const apiKey = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;

  if (!apiKey || !secret) {
    return [authRequiredRow("Bybit", symbol, "配置 BYBIT_API_KEY / BYBIT_API_SECRET 后可查询")];
  }

  const query = `coin=${encodeURIComponent(symbol)}`;
  const timestamp = String(await getBybitServerTime());
  const recvWindow = "10000";
  const signPayload = timestamp + apiKey + recvWindow + query;
  const signature = crypto.createHmac("sha256", secret).update(signPayload).digest("hex");
  const data = await getJson(`https://api.bybit.com/v5/asset/coin/query-info?${query}`, {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-SIGN": signature,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow
  });

  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit request failed");

  const coin = (data.result?.rows || []).find((item) => item.coin === symbol);
  if (!coin) return [];

  return (coin.chains || []).map((chain) => ({
    exchange: "Bybit",
    symbol,
    network: normalizeNetwork(chain.chainType || chain.chain),
    depositStatus: chain.chainDeposit === "1" ? "open" : "closed",
    withdrawStatus: chain.chainWithdraw === "1" ? "open" : "closed",
    updatedAt: formatDateTime(new Date()),
    note: ""
  }));
}

async function getBybitServerTime() {
  const data = await getJson("https://api.bybit.com/v5/market/time");
  const time = data.result?.timeSecond
    ? Number(data.result.timeSecond) * 1000
    : Number(data.time);
  return Number.isFinite(time) ? time : Date.now();
}

async function fetchOkx(symbol) {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;

  if (!apiKey || !secret || !passphrase) {
    return [authRequiredRow("OKX", symbol, "配置 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 后可查询")];
  }

  const requestPath = `/api/v5/asset/currencies?ccy=${encodeURIComponent(symbol)}`;
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(timestamp + "GET" + requestPath)
    .digest("base64");

  const data = await getJson(`https://www.okx.com${requestPath}`, {
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase
  });

  if (data.code !== "0") throw new Error(data.msg || "OKX request failed");

  return (data.data || []).map((chain) => ({
    exchange: "OKX",
    symbol,
    network: normalizeNetwork(chain.chain || symbol),
    depositStatus: chain.canDep ? "open" : "closed",
    withdrawStatus: chain.canWd ? "open" : "closed",
    updatedAt: formatDateTime(new Date()),
    note: chain.needTag ? "需要 Memo/Tag" : ""
  }));
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "application/json", ...headers }, timeout: 12000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(formatHttpError(response.statusCode, body)));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Request timeout"));
    });
    request.on("error", reject);
  });
}

function formatHttpError(statusCode, body) {
  if (!body) return `HTTP ${statusCode}`;

  try {
    const parsed = JSON.parse(body);
    return `HTTP ${statusCode}: ${JSON.stringify(parsed, null, 2)}`;
  } catch (error) {
    return `HTTP ${statusCode}: ${body}`;
  }
}

function authRequiredRow(exchange, symbol, note) {
  return {
    exchange,
    symbol,
    network: "需 API Key",
    depositStatus: "unknown",
    withdrawStatus: "unknown",
    updatedAt: formatDateTime(new Date()),
    note
  };
}

function sanitizeSymbol(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "USDT";
}

function normalizeNetwork(network) {
  const value = String(network || "").trim();
  const map = {
    BEP20: "BSC(BEP20)",
    BSC: "BSC(BEP20)",
    BSC_BEP20: "BSC(BEP20)",
    TRC20: "TRON(TRC20)",
    TRX: "TRON(TRC20)",
    ERC20: "ETH(ERC20)",
    ETH: "ETH(ERC20)",
    ARBEVM: "Arbitrum",
    ArbitrumOne: "Arbitrum",
    OPETH: "Optimism",
    Optimism: "Optimism",
    AVAX_C: "Avalanche C",
    "AVAXC-Chain": "Avalanche C",
    MATIC: "Polygon"
  };

  return map[value] || value || "-";
}

function toBoolean(value) {
  return value === true || value === "true" || value === "1";
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getCachedStatus(symbol) {
  const entry = statusCache.get(symbol);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    statusCache.delete(symbol);
    return null;
  }

  return entry.value;
}

function setCachedStatus(symbol, value) {
  statusCache.set(symbol, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}
