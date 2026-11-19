# cf-workers-ai-mp3-to-text

A minimal Node.js CLI to transcribe audio and video files using [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) with the [Deepgram Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/) model.

Features:

- Speaker diarization (`[Speaker N]` labeled output)
- Automatic language detection
- Punctuation, smart formatting, and paragraphs
- Supports audio files (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`) and video files (`.mp4`, `.mov`, `.m4v`)
- Optional truncation of MP3s for cheap tests (`--max-minutes`)
- Audio duration, word count, and transcript coverage reporting, with a warning when a response looks truncated
- `--raw-out` to dump the raw Workers AI response for debugging
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

Save the raw API response for debugging:

```bash
node index.js meeting.mp3 --raw-out debug/raw.json
```

### Options

| Option            | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `--lang <bcp-47>` | Language hint (default: `fr`). `detect_language` is also enabled.               |
| `--max-minutes`   | Only send the first ~n minutes (128 kbps MP3 only). Useful for cheap tests.     |
| `--out <file>`    | Output text file (default: `transcript/<file-name>.txt`)                        |
| `--raw-out <file>`| Save the raw Workers AI JSON response for debugging                             |
| `-h, --help`      | Show help                                                                       |

### Environment variables

Set these in a `.env` file (loaded from the script's directory, so the CLI works from anywhere):

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | Your Cloudflare account ID         |
| `CLOUDFLARE_API_TOKEN`   | A Cloudflare API token with Workers AI access |

## Output

By default, transcripts are saved to `transcript/<file-name>.txt`. The `transcript/` directory is gitignored — your transcripts stay local.

Alongside the transcript, the CLI logs the audio duration, request time, word count, last word timestamp, and a coverage ratio. It warns when the transcript appears to stop before the end of the audio.

## Tests

```bash
npm test
```

The suite uses the built-in `node:test` runner and does not make network calls. It covers transcript extraction, payload/transport shape, and coverage reporting.

## Tips

Add an alias to your `~/.zshrc` (or `~/.bashrc`) to transcribe from anywhere without typing the full path:

```bash
# Transcribe an audio file to text with Workers AI (@cf/deepgram/nova-3)
# @example: audioToText ./audio.mp3 [--max-minutes 2] [--out notes.txt]
# Default output: ./transcript/<audio-name>.txt
alias audioToText='node /path/to/cf-workers-ai-mp3-to-text/index.js'
```

Then reload your shell (`source ~/.zshrc`) and run:

```bash
audioToText meeting.mp3 --max-minutes 2
```

Thanks to the dotenv path handling, the alias works from any directory — `.env` is always loaded from the script's own folder.

## Notes

- The REST API expects raw binary audio with options as query parameters. The documented JSON payload (`audio: { body, contentType }`) is only supported by the Workers binding, not the REST endpoint, so there is no JSON fallback.
- `@cf/deepgram/nova-3` is known to return incomplete transcripts for short audio (under ~150s). The CLI logs a coverage warning in that case; split longer audio into ~200s chunks if needed.
