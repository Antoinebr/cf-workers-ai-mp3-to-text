# cf-workers-ai-mp3-to-text

A minimal Node.js CLI to transcribe audio and video files using [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) with the [Deepgram Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/) model.

Features:

- Speaker diarization (`[Speaker N]` labeled output)
- Automatic language detection
- Punctuation, smart formatting, and paragraphs
- Supports audio files (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`) and video files (`.mp4`, `.mov`, `.m4v`)
- Optional truncation of MP3s for cheap tests (`--max-minutes`)
- Video audio extraction on macOS via built-in `afconvert` (no ffmpeg needed)

## Prerequisites

- **Node.js >= 18** (uses built-in `fetch`)
- A **Cloudflare account** with Workers AI REST API access
- **macOS** for video input (audio extraction uses `afconvert`, which is macOS-only). Pure audio files work on any platform.

## Setup

```bash
git clone https://github.com/Antoinebr/cf-workers-ai-mp3-to-text.git
cd cf-workers-ai-mp3-to-text
npm install
cp .env.example .env
```

Then fill in your credentials in `.env`:

```
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
```

You can get these from the Cloudflare dashboard: **Workers AI > Use REST API**.

## Usage

```bash
node index.js <file> [options]
```

Or via npm:

```bash
npm start -- <file> [options]
```

### Examples

Transcribe an MP3 in French (default language hint):

```bash
node index.js meeting.mp3
```

Transcribe a video file (audio is extracted locally first):

```bash
node index.js recording.mp4
```

Specify a different language hint:

```bash
node index.js podcast.mp3 --lang en
```

Quick cheap test — only send the first 5 minutes:

```bash
node index.js meeting.mp3 --max-minutes 5
```

Custom output file:

```bash
node index.js meeting.mp3 --out my-transcript.txt
```

### Options

| Option            | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `--lang <bcp-47>` | Language hint (default: `fr`). `detect_language` is also enabled.               |
| `--max-minutes`   | Only send the first ~n minutes (128 kbps MP3 only). Useful for cheap tests.     |
| `--out <file>`    | Output text file (default: `transcript/<file-name>.txt`)                        |
| `-h, --help`      | Show help                                                                       |

### Environment variables

Set these in a `.env` file (loaded from the script's directory, so the CLI works from anywhere):

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | Your Cloudflare account ID         |
| `CLOUDFLARE_API_TOKEN`   | A Cloudflare API token with Workers AI access |

## Output

By default, transcripts are saved to `transcript/<file-name>.txt`. The `transcript/` directory is gitignored — your transcripts stay local.

## Notes

- The CLI first tries sending raw binary audio; it falls back to base64-encoded JSON if the API returns HTTP 400.
- There is no test suite — this is a minimal single-file CLI.
