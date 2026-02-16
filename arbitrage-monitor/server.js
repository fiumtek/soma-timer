const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPDATE_INTERVAL = 8000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- API Helpers ---

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    timeout: 10000,
    ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// --- Gate.io APIs ---

async function getGateioLendingCoins() {
  // Gate.io margin lending currencies
  const data = await fetchJSON('https://api.gateio.ws/api/v4/margin/uni/currencies');
  // Returns array of objects with currency field
  const coins = new Set();
  for (const item of data) {
    if (item.currency) {
      coins.add(item.currency.toUpperCase());
    }
  }
  return coins;
}

async function getGateioTickers() {
  const data = await fetchJSON('https://api.gateio.ws/api/v4/spot/tickers');
  const tickers = {};
  for (const t of data) {
    if (t.currency_pair && t.currency_pair.endsWith('_USDT')) {
      const symbol = t.currency_pair.replace('_USDT', '');
      tickers[symbol] = {
        last: parseFloat(t.last) || 0,
        volume: parseFloat(t.base_volume) || 0,
        bid: parseFloat(t.highest_bid) || 0,
        ask: parseFloat(t.lowest_ask) || 0,
      };
    }
  }
  return tickers;
}

// --- Bithumb APIs ---

async function getBithumbTickers() {
  const data = await fetchJSON('https://api.bithumb.com/public/ticker/ALL_KRW');
  if (data.status !== '0000') throw new Error('Bithumb API error: ' + data.message);
  const tickers = {};
  for (const [symbol, info] of Object.entries(data.data)) {
    if (symbol === 'date') continue;
    tickers[symbol.toUpperCase()] = {
      last: parseFloat(info.closing_price) || 0,
      volume: parseFloat(info.units_traded_24H) || 0,
      bid: parseFloat(info.buy_price) || 0,
      ask: parseFloat(info.sell_price) || 0,
    };
  }
  return tickers;
}

async function getBithumbAssetStatus() {
  // Bithumb asset status (deposit/withdrawal)
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/assetsstatus/ALL');
    if (data.status !== '0000') return {};
    const status = {};
    for (const [symbol, info] of Object.entries(data.data)) {
      status[symbol.toUpperCase()] = {
        deposit: info.deposit_status === 1,
        withdrawal: info.withdrawal_status === 1,
      };
    }
    return status;
  } catch {
    return {};
  }
}

// --- USDT/KRW rate ---

async function getUsdtKrwRate() {
  // Use Bithumb USDT price as KRW rate
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/ticker/USDT_KRW');
    if (data.status === '0000') {
      return parseFloat(data.data.closing_price) || 1350;
    }
  } catch {
    // fallback
  }
  return 1350;
}

// --- Arbitrage Calculation ---

const BITHUMB_FEE = 0.0025; // 0.25%
const GATEIO_FEE = 0.002;   // 0.2%

function calculateArbitrage(bithumbPrice, gateioPrice, usdtKrw) {
  const gateioKrw = gateioPrice * usdtKrw;
  if (gateioKrw === 0 || bithumbPrice === 0) return null;

  // Buy on Gate.io (lower), sell on Bithumb (higher) → positive = profit
  const bithumbToGateio = ((bithumbPrice - gateioKrw) / gateioKrw) * 100;
  // Buy on Bithumb (lower), sell on Gate.io (higher)
  const gateioToBithumb = ((gateioKrw - bithumbPrice) / bithumbPrice) * 100;

  // Net after fees
  const totalFee = (BITHUMB_FEE + GATEIO_FEE) * 100; // 0.45%
  const netBithumbToGateio = bithumbToGateio - totalFee;
  const netGateioToBithumb = gateioToBithumb - totalFee;

  let direction, grossPct, netPct;
  if (bithumbToGateio > gateioToBithumb) {
    direction = 'Gate→빗썸';
    grossPct = bithumbToGateio;
    netPct = netBithumbToGateio;
  } else {
    direction = '빗썸→Gate';
    grossPct = gateioToBithumb;
    netPct = netGateioToBithumb;
  }

  return {
    bithumbPrice,
    gateioPrice,
    gateioKrw: Math.round(gateioKrw),
    priceDiff: Math.round(bithumbPrice - gateioKrw),
    direction,
    grossPct: parseFloat(grossPct.toFixed(2)),
    netPct: parseFloat(netPct.toFixed(2)),
  };
}

// --- Main Data Fetch ---

let cachedData = null;
let lastUpdate = null;
let errorMsg = null;

async function fetchArbitrageData() {
  try {
    const [lendingCoins, gateioTickers, bithumbTickers, assetStatus, usdtKrw] =
      await Promise.all([
        getGateioLendingCoins(),
        getGateioTickers(),
        getBithumbTickers(),
        getBithumbAssetStatus(),
        getUsdtKrwRate(),
      ]);

    const results = [];

    for (const symbol of lendingCoins) {
      const gt = gateioTickers[symbol];
      const bt = bithumbTickers[symbol];
      if (!gt || !bt) continue;
      if (gt.last === 0 || bt.last === 0) continue;

      const arb = calculateArbitrage(bt.last, gt.last, usdtKrw);
      if (!arb) continue;

      const asset = assetStatus[symbol] || { deposit: false, withdrawal: false };
      const volumeKrw = bt.volume * bt.last;

      // Estimated profit per 1,000,000 KRW trade
      const profitPer1M = Math.round((arb.netPct / 100) * 1000000);

      results.push({
        symbol,
        ...arb,
        usdtKrw,
        depositStatus: asset.deposit,
        withdrawalStatus: asset.withdrawal,
        bithumbVolume24h: volumeKrw,
        gateioVolume24h: gt.volume * gt.last * usdtKrw,
        profitPer1M,
      });
    }

    // Sort by net profit descending
    results.sort((a, b) => b.netPct - a.netPct);

    cachedData = {
      pairs: results,
      usdtKrw,
      lendingCount: lendingCoins.size,
      matchedCount: results.length,
      timestamp: new Date().toISOString(),
    };
    lastUpdate = Date.now();
    errorMsg = null;
  } catch (err) {
    console.error('Fetch error:', err.message);
    errorMsg = err.message;
  }
}

// --- REST API ---

app.get('/api/arbitrage', (_req, res) => {
  if (!cachedData) {
    return res.json({ error: 'Data not yet loaded', pairs: [] });
  }
  res.json(cachedData);
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: !!cachedData,
    lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
    error: errorMsg,
    uptime: process.uptime(),
  });
});

// --- WebSocket ---

wss.on('connection', (ws) => {
  console.log('WS client connected');
  // Send current data immediately
  if (cachedData) {
    ws.send(JSON.stringify(cachedData));
  }
  ws.on('close', () => console.log('WS client disconnected'));
});

function broadcastData() {
  if (!cachedData) return;
  const msg = JSON.stringify(cachedData);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// --- Startup ---

async function start() {
  console.log('Fetching initial data...');
  await fetchArbitrageData();
  console.log(
    cachedData
      ? `Loaded ${cachedData.matchedCount} pairs (USDT/KRW: ${cachedData.usdtKrw})`
      : 'Initial fetch failed, will retry...'
  );

  // Periodic updates
  setInterval(async () => {
    await fetchArbitrageData();
    broadcastData();
  }, UPDATE_INTERVAL);

  server.listen(PORT, () => {
    console.log(`Arbitrage monitor running at http://localhost:${PORT}`);
  });
}

start();
