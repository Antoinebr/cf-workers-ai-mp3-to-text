# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Single-file Node.js (ESM) CLI that transcribes audio/video files via the Cloudflare Workers AI REST API using `@cf/deepgram/nova-3`. All application logic lives in `index.js`. The only dependency is `dotenv`.

## Setup

```bash
npm install
cp .env.example .env   # fill in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
```

Requires Node.js >= 18 (uses built-in `fetch`). Video input (`.mp4`/`.mov`/`.m4v`) requires macOS (`afconvert`).

## Commands

- Run: `node index.js <file> [options]` or `npm start -- <file> [options]`
- Help: `node index.js --help`
- Syntax check: `node --check index.js`
- Manual smoke test: `node index.js sample.mp3 --max-minutes 1`

There is no test suite, linter, or typechecker. After changing `index.js`, at minimum run `node --check index.js` and `node index.js --help` and, if possible, a short real transcription (`--max-minutes 1`) to verify end-to-end behavior.

## Code conventions

- Plain modern JavaScript, ESM (`import`), no TypeScript, no build step.
- `node:`-prefixed imports for built-ins.
- Keep the single-file structure; do not add frameworks or dependencies unless strictly necessary.
- Do not add comments unless asked.

## Security

- NEVER commit `.env` or any Cloudflare credentials.
- `transcript/` output files are gitignored — only `transcript/README.md` is tracked. Do not commit transcripts; they may contain sensitive content.
- When editing `.gitignore`, if `node_modules`, `.env`, and `transcript/` remain covered.
