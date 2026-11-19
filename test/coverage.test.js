import test from "node:test";
import assert from "node:assert/strict";
import { describeCoverage, probeDuration } from "../index.js";

test("computes coverage from the last word", () => {
  const result = {
    metadata: { duration: 10 },
    results: {
      channels: [
        {
          alternatives: [
            { transcript: "one two three", words: [{ end: 1 }, { end: 9.5 }] },
          ],
        },
      ],
    },
  };

  const coverage = describeCoverage(result, "one two three");

  assert.equal(coverage.wordCount, 3);
  assert.equal(coverage.lastWordEnd, 9.5);
  assert.equal(coverage.coverage, 0.95);
});

test("coverage is null when duration is missing", () => {
  const result = {
    results: { channels: [{ alternatives: [{ transcript: "hi" }] }] },
  };

  assert.equal(describeCoverage(result, "hi").coverage, null);
});

test("uses a fallback duration and computes the word rate", () => {
  const result = {
    results: {
      channels: [{ alternatives: [{ transcript: "one two three", words: [{ end: 6 }] }] }],
    },
  };

  const coverage = describeCoverage(result, "one two three", 12);

  assert.equal(coverage.coverage, 0.5);
  assert.equal(coverage.wordsPerSecond, 0.25);
});

test("falls back to the last sentence end when words are missing", () => {
  const result = {
    metadata: { duration: 10 },
    results: {
      channels: [
        {
          alternatives: [
            {
              paragraphs: {
                paragraphs: [
                  { sentences: [{ end: 3 }] },
                  { sentences: [{ end: 8 }] },
                ],
              },
            },
          ],
        },
      ],
    },
  };

  const coverage = describeCoverage(result, "some text here");

  assert.equal(coverage.lastWordEnd, 8);
  assert.equal(coverage.coverage, 0.8);
});

test("clamps coverage to 1 when the last word overshoots the duration", () => {
  const result = {
    metadata: { duration: 5 },
    results: { channels: [{ alternatives: [{ words: [{ end: 10 }] }] }] },
  };

  assert.equal(describeCoverage(result, "text").coverage, 1);
});

test("returns null rates for a zero duration", () => {
  const result = {
    metadata: { duration: 0 },
    results: { channels: [{ alternatives: [{ words: [{ end: 1 }] }] }] },
  };

  const coverage = describeCoverage(result, "one two");

  assert.equal(coverage.coverage, null);
  assert.equal(coverage.wordsPerSecond, null);
});

test("probeDuration returns null when the file cannot be probed", async () => {
  assert.equal(await probeDuration("/nonexistent/nova3-fixture.mp3"), null);
});
