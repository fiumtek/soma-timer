const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPDATE_INTERVAL = 3000;
const SLOW_CACHE_TTL = 30000;
const BITHUMB_FEE = 0.0025;
const GATEIO_FEE = 0.002;
const TOTAL_FEE_PCT = (BITHUMB_FEE + GATEIO_FEE) * 100;

app.use(express.static(path.join(__dirname, 'public')));

// ── Fetch helper with retry ──

async function fetchJSON(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { timeout: 10000, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr.message}`);
}

// ── Gate.io APIs ──

async function getGateioLendingCoins() {
  // 2023년 이후 /margin/uni → /earn/uni 로 마이그레이션됨
  const data = await fetchJSON('https://api.gateio.ws/api/v4/earn/uni/currencies');
  const coins = new Set();
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.currency) coins.add(item.currency.toUpperCase());
    }
  }
  return coins;
}

async function getGateioTickers() {
  const data = await fetchJSON('https://api.gateio.ws/api/v4/spot/tickers');
  const map = {};
  if (Array.isArray(data)) {
    for (const t of data) {
      if (t.currency_pair && t.currency_pair.endsWith('_USDT')) {
        const sym = t.currency_pair.replace('_USDT', '');
        map[sym] = {
          last: +t.last || 0,
          bid: +t.highest_bid || 0,
          ask: +t.lowest_ask || 0,
          vol: +t.base_volume || 0,
        };
      }
    }
  }
  return map;
}

async function getGateioCurrencies() {
  const data = await fetchJSON('https://api.gateio.ws/api/v4/spot/currencies');
  const map = {};
  if (Array.isArray(data)) {
    for (const c of data) {
      const sym = (c.currency || '').toUpperCase();
      if (!sym) continue;
      if (!map[sym]) {
        map[sym] = { deposit: !c.deposit_disabled, withdrawal: !c.withdraw_disabled };
      } else {
        if (!c.deposit_disabled) map[sym].deposit = true;
        if (!c.withdraw_disabled) map[sym].withdrawal = true;
      }
    }
  }
  return map;
}

// ── Bithumb APIs ──

async function getBithumbTickers() {
  const data = await fetchJSON('https://api.bithumb.com/public/ticker/ALL_KRW');
  if (!data || data.status !== '0000') throw new Error('Bithumb ticker: ' + (data?.message || 'error'));
  const map = {};
  for (const [k, v] of Object.entries(data.data)) {
    if (k === 'date') continue;
    map[k.toUpperCase()] = {
      last: +v.closing_price || 0,
      bid: +v.buy_price || 0,
      ask: +v.sell_price || 0,
      vol: +v.units_traded_24H || 0,
    };
  }
  return map;
}

async function getBithumbAssetStatus() {
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/assetsstatus/ALL');
    if (!data || data.status !== '0000') return {};
    const map = {};
    for (const [k, v] of Object.entries(data.data)) {
      map[k.toUpperCase()] = {
        deposit: Number(v.deposit_status) === 1,
        withdrawal: Number(v.withdrawal_status) === 1,
      };
    }
    return map;
  } catch {
    return {};
  }
}

async function getUsdtKrwRate() {
  try {
    const data = await fetchJSON('https://api.bithumb.com/public/ticker/USDT_KRW');
    if (data?.status === '0000') return +data.data.closing_price || 1380;
  } catch {}
  return 1380;
}

// ── Arbitrage Calculation ──

function calcArbitrage(bt, gt, rate) {
  const gBuyKrw = gt.ask * rate;
  const bSell = bt.bid;
  const bBuy = bt.ask;
  const gSellKrw = gt.bid * rate;
  if (!gBuyKrw || !bSell || !bBuy || !gSellKrw) return null;

  const g2b = ((bSell - gBuyKrw) / gBuyKrw) * 100;
  const b2g = ((gSellKrw - bBuy) / bBuy) * 100;

  let dir, gross, buy, sell;
  if (g2b > b2g) { dir = 'Gate→빗썸'; gross = g2b; buy = gBuyKrw; sell = bSell; }
  else           { dir = '빗썸→Gate'; gross = b2g; buy = bBuy; sell = gSellKrw; }

  const net = gross - TOTAL_FEE_PCT;
  return {
    direction: dir,
    grossPct: +gross.toFixed(3),
    netPct: +net.toFixed(3),
    buyPrice: Math.round(buy),
    sellPrice: Math.round(sell),
    priceDiff: Math.round(sell - buy),
    profitPer1M: Math.round((net / 100) * 1000000),
  };
}

// ── Main Data Loop ──

let cachedData = null;
let cachedLending = null;
let cachedGateStatus = null;
let slowTime = 0;

async function fetchSlowData() {
  const now = Date.now();
  if (cachedLending && (now - slowTime) < SLOW_CACHE_TTL) return;
  try {
    const [lending, gateStatus] = await Promise.all([getGateioLendingCoins(), getGateioCurrencies()]);
    cachedLending = lending;
    cachedGateStatus = gateStatus;
    slowTime = now;
  } catch (e) {
    console.error('[slow]', e.message);
    if (!cachedLending) throw e;
  }
}

async function fetchData() {
  try {
    await fetchSlowData();
    const [gTick, bTick, bAsset, rate] = await Promise.all([
      getGateioTickers(), getBithumbTickers(), getBithumbAssetStatus(), getUsdtKrwRate(),
    ]);

    const results = [];
    for (const sym of cachedLending) {
      const g = gTick[sym], b = bTick[sym];
      if (!g || !b || !g.bid || !g.ask || !b.bid || !b.ask) continue;
      const arb = calcArbitrage(b, g, rate);
      if (!arb) continue;
      const ba = bAsset[sym] || { deposit: false, withdrawal: false };
      const ga = cachedGateStatus[sym] || { deposit: false, withdrawal: false };
      results.push({
        symbol: sym,
        ...arb,
        bDep: ba.deposit, bWth: ba.withdrawal,
        gDep: ga.deposit, gWth: ga.withdrawal,
        bVol: b.vol * b.last,
      });
    }

    results.sort((a, b) => b.netPct - a.netPct);
    const positive = results.filter(r => r.netPct > 0);

    cachedData = {
      pairs: positive.slice(0, 15),
      usdtKrw: rate,
      lendingCount: cachedLending.size,
      positiveCount: positive.length,
      totalCount: results.length,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[fetch]', e.message);
    if (!cachedData) {
      cachedData = { pairs: [], usdtKrw: 0, lendingCount: 0, positiveCount: 0, totalCount: 0, timestamp: new Date().toISOString(), error: e.message };
    }
  }
}

// ── REST ──

app.get('/api/arbitrage', (_req, res) => {
  res.json(cachedData || { pairs: [], error: 'Loading...' });
});

// ── WebSocket ──

wss.on('connection', ws => {
  if (cachedData) ws.send(JSON.stringify(cachedData));
});

function broadcast() {
  if (!cachedData || !wss.clients.size) return;
  const msg = JSON.stringify(cachedData);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// ── Start ──

server.listen(PORT, async () => {
  console.log(`\n  차익거래 모니터: http://localhost:${PORT}\n`);
  await fetchData();
  if (cachedData?.pairs?.length) {
    console.log(`  ${cachedData.positiveCount}개 수익 기회 / ${cachedData.totalCount}개 비교 (USDT ${cachedData.usdtKrw}원)`);
  } else {
    console.log('  초기 데이터 로드 중... 다음 갱신에서 표시됩니다.');
  }
  setInterval(async () => { await fetchData(); broadcast(); }, UPDATE_INTERVAL);
});
