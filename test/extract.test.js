import test from "node:test";
import assert from "node:assert/strict";
import { extractTranscript } from "../index.js";

const fullTranscript = "Hello world. This is the full text. It should not be lost.";

test("uses the full transcript when paragraphs are shorter", () => {
  const result = {
    metadata: { duration: 12 },
    results: {
      channels: [
        {
          detected_language: "en",
          alternatives: [
            {
              transcript: fullTranscript,
              paragraphs: {
                paragraphs: [{ sentences: [{ text: "Hello world." }] }],
              },
            },
          ],
        },
      ],
    },
  };

  const extracted = extractTranscript(result);

  assert.equal(extracted.transcript, fullTranscript);
  assert.equal(extracted.detectedLanguage, "en");
  assert.equal(extracted.duration, 12);
});

test("uses the full transcript when paragraphs cover almost all of it", () => {
  const transcript =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
  const incomplete = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";

  const result = {
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript,
              paragraphs: { paragraphs: [{ sentences: [{ text: incomplete }] }] },
            },
          ],
        },
      ],
    },
  };

  assert.equal(extractTranscript(result).transcript, transcript);
});

test("keeps paragraph formatting and speaker labels when coverage is complete", () => {
  const result = {
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: "Hello world. Second block.",
              paragraphs: {
                paragraphs: [
                  { speaker: 0, sentences: [{ text: "Hello world." }] },
                  { speaker: 1, sentences: [{ text: "Second block." }] },
                ],
              },
            },
          ],
        },
      ],
    },
  };

  const extracted = extractTranscript(result);

  assert.equal(
    extracted.transcript,
    "[Speaker 0] Hello world.\n\n[Speaker 1] Second block.",
  );
});

test("uses paragraphs when the transcript is missing", () => {
  const result = {
    results: {
      channels: [
        {
          alternatives: [
            {
              paragraphs: {
                paragraphs: [{ sentences: [{ text: "Only paragraphs." }] }],
              },
            },
          ],
        },
      ],
    },
  };

  assert.equal(extractTranscript(result).transcript, "Only paragraphs.");
});

test("uses the transcript when paragraphs are absent", () => {
  const result = {
    results: { channels: [{ alternatives: [{ transcript: fullTranscript }] }] },
  };

  assert.equal(extractTranscript(result).transcript, fullTranscript);
});

test("falls back to result.text", () => {
  assert.equal(extractTranscript({ text: "plain text" }).transcript, "plain text");
});

test("throws on an unknown response shape", () => {
  assert.throws(() => extractTranscript({}), /Unexpected response shape/);
});
