#!/usr/bin/env node
import dotenv from "dotenv";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

// Load .env from the script's own directory so the CLI works from anywhere
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)) });

const execFileAsync = promisify(execFile);

const MODEL = "@cf/deepgram/nova-3";
// 128 kbps MP3 => 16 000 bytes/s => ~960 000 bytes/min (used for --max-minutes estimate)
const BYTES_PER_MINUTE = 960_000;

const CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
// Video containers we can extract audio from locally with macOS afconvert (no ffmpeg needed)
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);

function parseArgs(argv) {
  const args = { lang: "fr", out: null, maxMinutes: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang") args.lang = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--max-minutes") args.maxMinutes = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.file) args.file = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: node index.js <file> [options]

Input: .mp3 .m4a .wav .flac .ogg or video .mp4/.mov/.m4v (audio extracted locally via afconvert)

Options:
  --lang <bcp-47>      Language hint (default: "fr"). detect_language is also enabled.
  --max-minutes <n>    Only send the first ~n minutes (assumes 128 kbps MP3, .mp3 only). Useful for cheap tests.
  --out <file>         Output text file (default: transcript/<file-name>.txt)
  -h, --help           Show this help

Environment (via .env):
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN`);
}

const MODEL_OPTIONS = {
  punctuate: "true",
  smart_format: "true",
  paragraphs: "true",
  diarize: "true",
};

async function runNova3(audioBuffer, { accountId, apiToken, lang, contentType }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
  const params = new URLSearchParams({ language: lang, detect_language: "true", ...MODEL_OPTIONS });

  // Attempt 1: raw binary body (Deepgram-style), options as query params
  let res = await fetch(`${base}?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": contentType,
    },
    body: audioBuffer,
  });

  // Fallback: JSON with base64 audio if binary was rejected as a bad request
  if (res.status === 400) {
    res = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: audioBuffer.toString("base64"),
        language: lang,
        detect_language: true,
        punctuate: true,
        smart_format: true,
        paragraphs: true,
        diarize: true,
      }),
    });
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.length ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`Workers AI request failed: ${detail}`);
  }
  return json.result;
}

function extractTranscript(result) {
  // Deepgram response shape
  const channel = result?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];

  // With paragraphs + diarize, build a speaker-labeled, readable text
  const paragraphs = alt?.paragraphs?.paragraphs;
  if (Array.isArray(paragraphs) && paragraphs.length) {
    const lines = [];
    for (const p of paragraphs) {
      const text = (p.sentences ?? []).map((s) => s.text).join(" ") || p.text || "";
      if (!text.trim()) continue;
      lines.push(p.speaker !== undefined ? `[Speaker ${p.speaker}] ${text}` : text);
    }
    if (lines.length) {
      return {
        transcript: lines.join("\n\n"),
        detectedLanguage: channel?.detected_language,
        duration: result?.metadata?.duration,
      };
    }
  }

  if (typeof alt?.transcript === "string") {
    return {
      transcript: alt.transcript,
      detectedLanguage: channel?.detected_language,
      duration: result?.metadata?.duration,
    };
  }
  // Fallback: some audio models return { text }
  if (typeof result?.text === "string") return { transcript: result.text };
  throw new Error(`Unexpected response shape: ${JSON.stringify(result).slice(0, 500)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) return usage();

  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Fill in your .env file.");
    process.exit(1);
  }

  const ext = extname(args.file).toLowerCase();
  let contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  let tempFile = null;

  try {
    let audio;
    if (VIDEO_EXTENSIONS.has(ext)) {
      // Extract the audio track locally (macOS built-in afconvert) — much smaller upload
      tempFile = join(tmpdir(), `audiototext-${process.pid}-${Date.now()}.m4a`);
      console.log(`Extracting audio track from ${basename(args.file)} with afconvert...`);
      await execFileAsync("afconvert", ["-f", "m4af", "-d", "aac", args.file, tempFile]);
      audio = await readFile(tempFile);
      contentType = "audio/mp4";
    } else {
      audio = await readFile(args.file);
    }

    const totalMB = (audio.byteLength / 1e6).toFixed(1);
    if (args.maxMinutes && ext === ".mp3") {
      const maxBytes = Math.floor(args.maxMinutes * BYTES_PER_MINUTE);
      audio = audio.subarray(0, Math.min(maxBytes, audio.byteLength));
      console.log(`Sending first ~${args.maxMinutes} min (${(audio.byteLength / 1e6).toFixed(1)} MB of ${totalMB} MB)...`);
    } else {
      if (args.maxMinutes && ext !== ".mp3") {
        console.log(`Note: --max-minutes only applies to .mp3 (stream format), sending the full audio.`);
      }
      console.log(`Sending ${totalMB} MB to ${MODEL}...`);
    }

    const t0 = Date.now();
    const result = await runNova3(audio, {
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken: CLOUDFLARE_API_TOKEN,
      lang: args.lang,
      contentType,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const { transcript, detectedLanguage, duration } = extractTranscript(result);

    console.log(`\n--- Transcript (${elapsed}s) ---`);
    if (detectedLanguage) console.log(`Detected language: ${detectedLanguage}`);
    if (duration) console.log(`Audio duration processed: ${duration.toFixed?.(1) ?? duration}s`);
    console.log(`\n${transcript}\n`);

    const outFile = args.out ?? join("transcript", `${parsePath(args.file).name}.txt`);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, transcript + "\n", "utf8");
    console.log(`Saved to ${outFile}`);
  } finally {
    if (tempFile) await rm(tempFile, { force: true });
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
