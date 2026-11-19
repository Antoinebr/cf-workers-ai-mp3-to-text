#!/usr/bin/env node
import dotenv from "dotenv";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse as parsePath, resolve } from "node:path";
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

const BOOLEAN_OPTIONS = {
  punctuate: true,
  smart_format: true,
  paragraphs: true,
  diarize: true,
};

export function parseArgs(argv) {
  const args = { lang: "fr", out: null, maxMinutes: null, rawOut: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang") args.lang = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--raw-out") args.rawOut = argv[++i];
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
  --raw-out <file>     Save the raw Workers AI JSON response for debugging
  -h, --help           Show this help

Environment (via .env):
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN`);
}

export function buildQueryParams({ lang }) {
  const params = new URLSearchParams({ language: lang, detect_language: "true" });
  for (const [key, value] of Object.entries(BOOLEAN_OPTIONS)) {
    params.set(key, String(value));
  }
  return params;
}

async function requestBinary(base, audioBuffer, { apiToken, lang, contentType }) {
  return fetch(`${base}?${buildQueryParams({ lang })}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": contentType,
    },
    body: audioBuffer,
  });
}

export async function runNova3(audioBuffer, { accountId, apiToken, lang, contentType, rawOut }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
  const res = await requestBinary(base, audioBuffer, { apiToken, lang, contentType });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.length ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(
      `Workers AI request failed: ${detail}. The REST API expects raw binary audio with options as query parameters; the JSON audio schema is only supported by the Workers binding.`,
    );
  }

  if (rawOut) {
    await mkdir(dirname(rawOut), { recursive: true });
    await writeFile(rawOut, JSON.stringify(json, null, 2), "utf8");
  }

  return { result: json.result };
}

function countWords(text) {
  return (text.match(/\S+/g) ?? []).length;
}

function stripSpeakerLabels(text) {
  return text.replace(/\[Speaker [^\]]+\]/g, " ");
}

function paragraphsToText(paragraphs) {
  const blocks = [];
  for (const paragraph of paragraphs) {
    const text =
      (paragraph.sentences ?? []).map((sentence) => sentence.text).join(" ") ||
      paragraph.text ||
      "";
    if (!text.trim()) continue;
    blocks.push(paragraph.speaker !== undefined ? `[Speaker ${paragraph.speaker}] ${text}` : text);
  }
  return blocks.join("\n\n");
}

export function extractTranscript(result) {
  const channel = result?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const transcript = typeof alt?.transcript === "string" ? alt.transcript : "";
  const paragraphs = Array.isArray(alt?.paragraphs?.paragraphs) ? alt.paragraphs.paragraphs : [];

  // Paragraphs are used for formatting only when they do not lose words.
  const formatted = paragraphs.length ? paragraphsToText(paragraphs) : "";
  const formattedWords = countWords(stripSpeakerLabels(formatted));
  const transcriptWords = countWords(transcript);

  let text = transcript;
  if (formatted && (!transcript.trim() || formattedWords >= transcriptWords)) {
    text = formatted;
  }
  if (!text.trim() && typeof result?.text === "string") {
    text = result.text;
  }
  if (!text.trim()) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return {
    transcript: text,
    detectedLanguage: channel?.detected_language,
    duration: result?.metadata?.duration,
  };
}

function lastSentenceEnd(alt) {
  const paragraphs = alt?.paragraphs?.paragraphs;
  if (!Array.isArray(paragraphs)) return undefined;
  let end;
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.sentences ?? []) {
      if (typeof sentence.end === "number") end = sentence.end;
    }
  }
  return end;
}

export function describeCoverage(result, transcript, fallbackDuration) {
  const alt = result?.results?.channels?.[0]?.alternatives?.[0];
  const words = Array.isArray(alt?.words) ? alt.words : [];
  const duration = result?.metadata?.duration ?? fallbackDuration ?? null;

  let lastWordEnd;
  for (const word of words) {
    if (typeof word?.end === "number") lastWordEnd = word.end;
  }
  if (lastWordEnd === undefined) lastWordEnd = lastSentenceEnd(alt);

  const coverage =
    typeof duration === "number" && duration > 0 && typeof lastWordEnd === "number"
      ? Math.min(1, lastWordEnd / duration)
      : null;
  const wordCount = countWords(stripSpeakerLabels(transcript));

  return {
    duration,
    lastWordEnd,
    wordCount,
    wordsPerSecond:
      typeof duration === "number" && duration > 0 ? wordCount / duration : null,
    coverage,
  };
}

export async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ]);
    const value = Number.parseFloat(stdout.trim());
    if (Number.isFinite(value)) return value;
  } catch {}

  try {
    const { stdout } = await execFileAsync("afinfo", [file]);
    const match = stdout.match(/estimated duration:\s+([\d.]+)/);
    if (match) return Number.parseFloat(match[1]);
  } catch {}

  return null;
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
      console.log(
        `Sending first ~${args.maxMinutes} min (${(audio.byteLength / 1e6).toFixed(1)} MB of ${totalMB} MB)...`,
      );
    } else {
      if (args.maxMinutes && ext !== ".mp3") {
        console.log(`Note: --max-minutes only applies to .mp3 (stream format), sending the full audio.`);
      }
      console.log(`Sending ${totalMB} MB to ${MODEL}...`);
    }

    const localDuration = await probeDuration(args.file);

    const t0 = Date.now();
    const { result } = await runNova3(audio, {
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken: CLOUDFLARE_API_TOKEN,
      lang: args.lang,
      contentType,
      rawOut: args.rawOut,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const { transcript, detectedLanguage } = extractTranscript(result);
    const coverage = describeCoverage(result, transcript, localDuration);

    console.log(`\n--- Transcript ---`);
    if (detectedLanguage) console.log(`Detected language: ${detectedLanguage}`);
    if (typeof coverage.duration === "number") {
      console.log(`Audio duration: ${coverage.duration.toFixed(1)}s`);
    }
    console.log(`Request time: ${elapsed}s`);
    console.log(`Transport: raw binary`);
    console.log(`Words: ${coverage.wordCount}`);
    if (typeof coverage.lastWordEnd === "number") {
      console.log(`Last word ends at: ${coverage.lastWordEnd.toFixed(1)}s`);
    }
    if (typeof coverage.coverage === "number") {
      console.log(`Coverage: ${(coverage.coverage * 100).toFixed(0)}%`);
    }
    if (typeof coverage.wordsPerSecond === "number") {
      console.log(`Word rate: ${coverage.wordsPerSecond.toFixed(2)} words/s`);
    }
    if (typeof coverage.coverage === "number" && coverage.coverage < 0.9) {
      console.warn(`Warning: transcript stops well before the end of the audio. The response may be truncated.`);
    }
    if (typeof coverage.wordsPerSecond === "number" && coverage.wordsPerSecond < 0.3) {
      console.warn(`Warning: very few words for this audio duration. The transcript may be incomplete.`);
    }
    if (typeof coverage.duration === "number" && coverage.duration < 150) {
      console.warn(`Warning: nova-3 is known to return incomplete transcripts for audio under ~150s. Verify this output or split longer audio into 200s chunks.`);
    }
    console.log(`\n${transcript}\n`);

    const outFile = args.out ?? join("transcript", `${parsePath(args.file).name}.txt`);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, transcript + "\n", "utf8");
    console.log(`Saved to ${resolve(outFile)}`);
  } finally {
    if (tempFile) await rm(tempFile, { force: true });
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
