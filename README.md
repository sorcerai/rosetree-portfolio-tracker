# Rosetree Portfolio Tracker

A hybrid-asset portfolio tracker for stocks and crypto with real-time price updates.

## Architecture

**Supabase-First**: Single platform for auth, database, and APIs
- **Frontend**: Next.js 15 + React 19 + Tailwind + shadcn/ui  
- **Database**: Supabase Pro + TimescaleDB for time-series data
- **Auth**: Supabase Auth + TOTP 2FA
- **ORM**: Drizzle (edge-optimized)
- **Market Data**: Real-time WebSocket (Polygon.io/Finnhub)

## Phase 1: Proof of Concept

Goal: End-to-end validation with single holding + live prices

1. Supabase setup with TimescaleDB
2. Basic auth with TOTP
3. Single holding CRUD
4. Real-time price updates
5. Portfolio value calculation

## Development

```bash
npm install
npm run dev
```

## License

MIT