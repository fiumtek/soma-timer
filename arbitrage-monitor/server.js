const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPDATE_INTERVAL = 3000; // 3초 간격

app.use(express.static(path.join(__dirname, 'public')));

// --- API Helpers ---

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { timeout: 8000, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// --- Gate.io APIs ---

async function getGateioLendingCoins() {
  const data = await fetchJSON('https://api.gateio.ws/api/v4/margin/uni/currencies');
  const coins = new Set();
  for (const item of data) {
    if (item.currency) coins.add(item.currency.toUpperCase());
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

async function getGateioCurrencies() {
  const data = await fetchJSON('https://api.gateio.ws/api/v4/spot/currencies');
  const status = {};
  for (const c of data) {
    const sym = c.currency.toUpperCase();
    // 같은 코인의 여러 체인이 있을 수 있음 — 하나라도 가능하면 가능으로 처리
    if (!status[sym]) {
      status[sym] = {
        deposit: !c.deposit_disabled,
        withdrawal: !c.withdraw_disabled,
        delisted: !!c.delisted,
        chains: [],
      };
    } else {
      if (!c.deposit_disabled) status[sym].deposit = true;
      if (!c.withdraw_disabled) status[sym].withdrawal = true;
    }
    status[sym].chains.push({
      chain: c.chain || '',
      deposit: !c.deposit_disabled,
      withdrawal: !c.withdraw_disabled,
    });
  }
  return status;
}

// --- Bithumb APIs ---

async function getBithumbTickers() {
  const data = await fetchJSON('https://api.bithumb.com/public/ticker/ALL_KRW');
  if (data.status !== '0000') throw new Error('Bithumb ticker error: ' + data.message);
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
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/assetsstatus/ALL');
    if (data.status !== '0000') return {};
    const status = {};
    for (const [symbol, info] of Object.entries(data.data)) {
      status[symbol.toUpperCase()] = {
        // 빗썸 API는 정수(1/0) 또는 문자열("1"/"0") 반환 가능
        deposit: Number(info.deposit_status) === 1,
        withdrawal: Number(info.withdrawal_status) === 1,
      };
    }
    return status;
  } catch (e) {
    console.error('Bithumb asset status error:', e.message);
    return {};
  }
}

async function getBithumbNetworkInfo() {
  // 멀티체인 네트워크 정보
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/assetsstatus/multichain/ALL');
    if (data.status !== '0000') return {};
    const info = {};
    for (const [symbol, chains] of Object.entries(data.data)) {
      const sym = symbol.toUpperCase();
      if (Array.isArray(chains)) {
        info[sym] = chains.map(c => ({
          network: c.net_type || c.network || '',
          deposit: Number(c.deposit_status) === 1,
          withdrawal: Number(c.withdrawal_status) === 1,
        }));
      }
    }
    return info;
  } catch {
    return {};
  }
}

// --- USDT/KRW ---

async function getUsdtKrwRate() {
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/ticker/USDT_KRW');
    if (data.status === '0000') {
      return parseFloat(data.data.closing_price) || 1350;
    }
  } catch {}
  return 1350;
}

// --- Arbitrage Calculation (bid/ask 기반) ---

const BITHUMB_FEE = 0.0025;
const GATEIO_FEE = 0.002;

function calculateArbitrage(bithumb, gateio, usdtKrw) {
  // Gate→빗썸: Gate에서 ask로 매수, 빗썸에서 bid로 매도
  const gateBuyKrw = gateio.ask * usdtKrw;  // Gate에서 사는 가격 (KRW)
  const bithumbSell = bithumb.bid;            // 빗썸에서 파는 가격 (KRW)

  // 빗썸→Gate: 빗썸에서 ask로 매수, Gate에서 bid로 매도
  const bithumbBuy = bithumb.ask;             // 빗썸에서 사는 가격 (KRW)
  const gateSellKrw = gateio.bid * usdtKrw;  // Gate에서 파는 가격 (KRW)

  if (gateBuyKrw === 0 || bithumbSell === 0 || bithumbBuy === 0 || gateSellKrw === 0) return null;

  // Gate→빗썸 수익률 (Gate에서 사서 빗썸에서 팔기)
  const grossGateToBithumb = ((bithumbSell - gateBuyKrw) / gateBuyKrw) * 100;
  // 빗썸→Gate 수익률 (빗썸에서 사서 Gate에서 팔기)
  const grossBithumbToGate = ((gateSellKrw - bithumbBuy) / bithumbBuy) * 100;

  const totalFeePct = (BITHUMB_FEE + GATEIO_FEE) * 100; // 0.45%

  let direction, grossPct, netPct, buyPrice, sellPrice;

  if (grossGateToBithumb > grossBithumbToGate) {
    direction = 'Gate→빗썸';
    grossPct = grossGateToBithumb;
    netPct = grossGateToBithumb - totalFeePct;
    buyPrice = gateBuyKrw;
    sellPrice = bithumbSell;
  } else {
    direction = '빗썸→Gate';
    grossPct = grossBithumbToGate;
    netPct = grossBithumbToGate - totalFeePct;
    buyPrice = bithumbBuy;
    sellPrice = gateSellKrw;
  }

  return {
    bithumbBid: bithumb.bid,
    bithumbAsk: bithumb.ask,
    bithumbLast: bithumb.last,
    gateioLast: gateio.last,
    gateioBid: gateio.bid,
    gateioAsk: gateio.ask,
    gateioKrw: Math.round(gateio.last * usdtKrw),
    buyPrice: Math.round(buyPrice),
    sellPrice: Math.round(sellPrice),
    priceDiff: Math.round(sellPrice - buyPrice),
    direction,
    grossPct: parseFloat(grossPct.toFixed(3)),
    netPct: parseFloat(netPct.toFixed(3)),
  };
}

// --- Main Data Fetch ---

let cachedData = null;
let lastUpdate = null;
let errorMsg = null;

// 렌딩 코인/Gate 통화 상태는 30초마다만 갱신 (변동 적음)
let cachedLendingCoins = null;
let cachedGateioStatus = null;
let cachedBithumbNetwork = null;
let slowCacheTime = 0;
const SLOW_CACHE_TTL = 30000;

async function fetchSlowData() {
  const now = Date.now();
  if (cachedLendingCoins && (now - slowCacheTime) < SLOW_CACHE_TTL) {
    return {
      lendingCoins: cachedLendingCoins,
      gateioStatus: cachedGateioStatus,
      bithumbNetwork: cachedBithumbNetwork,
    };
  }
  const [lendingCoins, gateioStatus, bithumbNetwork] = await Promise.all([
    getGateioLendingCoins(),
    getGateioCurrencies(),
    getBithumbNetworkInfo(),
  ]);
  cachedLendingCoins = lendingCoins;
  cachedGateioStatus = gateioStatus;
  cachedBithumbNetwork = bithumbNetwork;
  slowCacheTime = now;
  return { lendingCoins, gateioStatus, bithumbNetwork };
}

async function fetchArbitrageData() {
  try {
    const [slowData, gateioTickers, bithumbTickers, bithumbAsset, usdtKrw] =
      await Promise.all([
        fetchSlowData(),
        getGateioTickers(),
        getBithumbTickers(),
        getBithumbAssetStatus(),
        getUsdtKrwRate(),
      ]);

    const { lendingCoins, gateioStatus, bithumbNetwork } = slowData;
    const results = [];

    for (const symbol of lendingCoins) {
      const gt = gateioTickers[symbol];
      const bt = bithumbTickers[symbol];
      if (!gt || !bt) continue;
      if (gt.last === 0 || bt.last === 0) continue;
      if (gt.bid === 0 || gt.ask === 0 || bt.bid === 0 || bt.ask === 0) continue;

      const arb = calculateArbitrage(bt, gt, usdtKrw);
      if (!arb) continue;

      // 빗썸 입출금 상태
      const bAsset = bithumbAsset[symbol] || { deposit: false, withdrawal: false };
      // 빗썸 네트워크 정보
      const bNetwork = bithumbNetwork[symbol] || [];
      // Gate.io 입출금 상태
      const gAsset = gateioStatus[symbol] || { deposit: false, withdrawal: false, chains: [] };

      const volumeKrw = bt.volume * bt.last;
      const profitPer1M = Math.round((arb.netPct / 100) * 1000000);

      results.push({
        symbol,
        ...arb,
        usdtKrw,
        // 빗썸
        bithumbDeposit: bAsset.deposit,
        bithumbWithdrawal: bAsset.withdrawal,
        bithumbNetworks: bNetwork,
        // Gate.io
        gateioDeposit: gAsset.deposit,
        gateioWithdrawal: gAsset.withdrawal,
        gateioChains: gAsset.chains || [],
        // 거래량
        bithumbVolume24h: volumeKrw,
        gateioVolume24h: gt.volume * gt.last * usdtKrw,
        profitPer1M,
      });
    }

    // 순수익률 내림차순 정렬 → 양수만 → 상위 15개
    results.sort((a, b) => b.netPct - a.netPct);
    const topResults = results.filter(r => r.netPct > 0).slice(0, 15);

    // 양수 수익이 15개 미만이면 음수 중 가장 높은 것도 포함해 최소 보여줄 수 있도록
    // (사용자가 원하면 프론트에서 필터 해제 가능)

    cachedData = {
      pairs: topResults,
      allCount: results.length,
      positiveCount: results.filter(r => r.netPct > 0).length,
      usdtKrw,
      lendingCount: lendingCoins.size,
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
  if (!cachedData) return res.json({ error: 'Data not yet loaded', pairs: [] });
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
  if (cachedData) ws.send(JSON.stringify(cachedData));
  ws.on('close', () => {});
});

function broadcastData() {
  if (!cachedData) return;
  const msg = JSON.stringify(cachedData);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// --- Startup ---

async function start() {
  // 서버를 먼저 시작 (API 실패와 무관하게 접속 가능)
  server.listen(PORT, () => {
    console.log(`Arbitrage monitor running at http://localhost:${PORT}`);
    console.log(`Update interval: ${UPDATE_INTERVAL / 1000}s`);
  });

  console.log('Fetching initial data...');
  await fetchArbitrageData();
  if (cachedData) {
    console.log(`Loaded ${cachedData.positiveCount} profitable pairs / ${cachedData.allCount} total (USDT/KRW: ${cachedData.usdtKrw})`);
  } else {
    console.log('Initial fetch failed, will retry on next interval...');
  }

  setInterval(async () => {
    await fetchArbitrageData();
    broadcastData();
  }, UPDATE_INTERVAL);
}

start();
