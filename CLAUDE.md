# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a single-file, zero-dependency web app (`index.html`) — a dual-agent stock portfolio analyzer powered by the Anthropic Claude API, with Google SSO login. No build step, no package manager, no server required. Open the HTML file directly in a browser (or serve locally — Google Sign-In requires HTTP, not `file://`).

## Running

```bash
python3 -m http.server 8080   # then open http://localhost:8080/index.html
```

Google Sign-In will fail on `file://` — always serve via HTTP. `localhost:8080` must be added as an Authorized JavaScript origin in Google Cloud Console for the OAuth button to work.

The user enters their Anthropic API key in the UI and clicks "Run Analysis". The key is never persisted.

## Architecture

Everything lives in `index.html` as a single page with inline CSS and JS. The JS is organized into four logical layers:

**Auth layer** (top of `<script>`)
- `GOOGLE_CLIENT_ID` — OAuth 2.0 Client ID (public, safe to commit)
- `ALLOWED_EMAILS` — allowlist of permitted Google accounts; checked client-side (move to backend for real security)
- `initAuth()` / `onGoogleSignIn()` — initializes Google Identity Services, verifies JWT, gates the app behind the login screen

**Data layer**
- `PORTFOLIO` — hardcoded array of 12 stock positions with ticker, shares, entry price, and CZK value
- `SOURCES` — per-ticker curated links (IR pages, Yahoo Finance, Seeking Alpha)

**API layer**
- `callClaude(apiKey, prompt)` — calls `https://api.anthropic.com/v1/messages` directly from the browser using the `anthropic-dangerous-direct-browser-access: true` header; model `claude-sonnet-4-20250514`; 3 retries with exponential backoff on 429; 45s timeout
- `parseJSON(raw)` — strips markdown fences and extracts JSON from Claude's response

**Agent orchestration** (`runAgents()`)
1. **Price fetch** — single Claude call asking for current prices and daily % change for all tickers; results are stored back into `PORTFOLIO[i].livePrice` and `PORTFOLIO[i].dailyChange`
2. **Agent 1 (Scanner)** — single Claude call over the full portfolio; identifies top 3 / bottom 3 movers, high-risk stocks (dailyChange ≤ −3%), total portfolio value in CZK
3. **Agent 2 (Analyst)** — sequential loop: one Claude call per stock, returns `{signal, reason, confidence, keyMetric}` JSON; updates each card in real-time as results arrive with a 700 ms inter-request delay

All Claude responses are expected as strict JSON (no markdown). Prompts explicitly instruct Claude to return `JSON only no markdown`.

## Modifying the portfolio

Edit the `PORTFOLIO` array at the top of the `<script>` block. Each entry:
```js
{ name:"Company", ticker:"TICK", shares:0.0, price:0.00, value_czk:0.00 }
```
Also add a corresponding entry in `SOURCES` for the source chips to appear.

## Key constraints

- **Direct browser API calls** — the `anthropic-dangerous-direct-browser-access` header is required; without it Anthropic's API rejects browser-origin requests
- **Sequential analysis** — Agent 2 processes stocks one at a time deliberately to stay within rate limits; parallelizing will hit 429s
- **Prices via Claude** — there is no real-time market data API; prices come from Claude's training knowledge and will lag the actual market