# Kanban Factory

A Kanban-style orchestrator for building apps with Claude agents.

Each tab = one app being built. You create tasks. An **Architect** agent plans them, **Specialist** agents execute, a **Reviewer** agent approves. Tasks move through columns as agents work.

## Quick start

```bash
cp .env.example .env
# put your ANTHROPIC_API_KEY in .env
npm install
npm run smoke   # verify SDK works
npm run dev     # http://localhost:3000
```

## Architecture

- `apps/web` — Vite + React frontend (port 3000)
- `apps/server` — Node + Express + WebSocket + SQLite + Claude Agent SDK (port 4000)

## Status

v1 walking skeleton. Single linear flow: Architect → Specialist → Reviewer → Done. See `C:\Users\b-c-g\.claude\plans\lovely-watching-deer.md`.
