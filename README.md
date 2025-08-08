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

1. ✅ Project setup with Next.js 15
2. 🔄 Supabase setup with TimescaleDB
3. ⏳ Basic auth with TOTP
4. ⏳ Single holding CRUD
5. ⏳ Real-time price updates
6. ⏳ Portfolio value calculation

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

```
src/
├── app/              # App Router pages
├── components/       # Reusable UI components
├── lib/             # Utilities, DB, auth
├── types/           # TypeScript type definitions
└── hooks/           # Custom React hooks
```

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Styling**: Tailwind CSS + shadcn/ui components
- **Database**: Supabase + TimescaleDB extension
- **ORM**: Drizzle with edge optimization
- **Auth**: Supabase Auth + TOTP 2FA
- **Market Data**: WebSocket connections (real-time)
- **State**: React 19 with Server Components
- **Validation**: Zod schemas

## License

MIT