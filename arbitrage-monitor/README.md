# 빗썸 ↔ Gate.io 차익거래 모니터

Gate.io 렌딩(대출) 가능 코인 전용 실시간 차익거래 모니터링 시스템

## 빠른 시작

```bash
cd arbitrage-monitor
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속

## 구조

```
arbitrage-monitor/
├── server.js          # Express + WebSocket 백엔드
├── public/
│   └── index.html     # 프론트엔드 (실시간 테이블)
├── package.json
└── README.md
```

## 기능

- **실시간 WebSocket** — 8초 간격 자동 갱신, 브라우저에 즉시 반영
- **CORS 우회** — 서버에서 API 프록시 처리
- **Gate.io 렌딩 가능 코인만** — 대출 미지원 코인 자동 제외
- **수익률 계산** — 빗썸 0.25% + Gate.io 0.2% 수수료 반영
- **입출금 상태** — 빗썸 입출금 현황 실시간 확인
- **정렬/필터** — 수익률, 거래량, 수익(원) 정렬 가능

## API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/arbitrage` | 차익거래 데이터 (JSON) |
| `GET /api/status` | 서버 상태 |
| `WS ws://localhost:3000` | 실시간 데이터 스트림 |

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 |
