import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQueryParams, parseArgs, runNova3 } from "../index.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

test("binary query params are strings", () => {
  const params = buildQueryParams({ lang: "en" });

  assert.equal(params.get("language"), "en");
  assert.equal(params.get("detect_language"), "true");
  assert.equal(params.get("punctuate"), "true");
  assert.equal(params.get("smart_format"), "true");
  assert.equal(params.get("paragraphs"), "true");
  assert.equal(params.get("diarize"), "true");
});

test("parses --raw-out", () => {
  const args = parseArgs(["--raw-out", "debug/raw.json", "audio.mp3"]);

  assert.equal(args.rawOut, "debug/raw.json");
  assert.equal(args.file, "audio.mp3");
});

test("uses defaults for omitted options", () => {
  const args = parseArgs(["audio.mp3"]);

  assert.equal(args.lang, "fr");
  assert.equal(args.out, null);
  assert.equal(args.maxMinutes, null);
  assert.equal(args.rawOut, null);
});

test("rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--nope", "audio.mp3"]), /Unknown argument/);
});

test("sends one raw binary request with options as query params", async (t) => {
  const audio = Buffer.from("audio-bytes");
  const calls = stubFetch(t, () => jsonResponse({ success: true, result: { ok: 1 } }));

  const out = await runNova3(audio, {
    accountId: "acc",
    apiToken: "token",
    lang: "en",
    contentType: "audio/mpeg",
  });

  assert.deepEqual(out, { result: { ok: 1 } });
  assert.equal(calls.length, 1);

  const [{ url, init }] = calls;
  assert.match(
    url,
    /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acc\/ai\/run\/@cf\/deepgram\/nova-3\?/,
  );
  const params = new URL(url).searchParams;
  assert.equal(params.get("language"), "en");
  assert.equal(params.get("detect_language"), "true");
  assert.equal(params.get("paragraphs"), "true");

  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer token");
  assert.equal(init.headers["Content-Type"], "audio/mpeg");
  assert.ok(Buffer.isBuffer(init.body));
  assert.deepEqual(init.body, audio);
});

test("does not fall back to a JSON payload on a 400", async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse({ success: false, errors: [{ message: "bad audio" }] }, { ok: false, status: 400 }),
  );

  await assert.rejects(
    () =>
      runNova3(Buffer.from("audio"), {
        accountId: "acc",
        apiToken: "token",
        lang: "en",
        contentType: "audio/mpeg",
      }),
    /Workers AI request failed/,
  );

  assert.equal(calls.length, 1);
});

test("writes the raw response when rawOut is set", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nova3-raw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const payload = { success: true, result: { text: "hello" }, metadata: { duration: 3 } };
  stubFetch(t, () => jsonResponse(payload));
  const rawOut = join(dir, "nested", "raw.json");

  await runNova3(Buffer.from("audio"), {
    accountId: "acc",
    apiToken: "token",
    lang: "fr",
    contentType: "audio/mpeg",
    rawOut,
  });

  assert.deepEqual(JSON.parse(await readFile(rawOut, "utf8")), payload);
});
