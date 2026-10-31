import test from "node:test";
import assert from "node:assert/strict";
import { frameLevel, HANG_MS, noteCapture, PREVIEW_CHUNK_MS, PREVIEW_QUIET_MS, QUIET_MS, SPEECH_RMS } from "../lib/capture.js";

test("speech and a short pause keep the recording and can show text", () => {
  const bucket = { heard: false, quiet: 0, elapsed: 0, chunkHeard: false, chunkQuiet: 0, chunkElapsed: 0 };
  assert.equal(noteCapture(bucket, 0.03, 400), "continue");
  assert.equal(noteCapture(bucket, SPEECH_RMS, 800), "continue");
  assert.equal(noteCapture(bucket, 0.001, PREVIEW_QUIET_MS), "preview");
  assert.equal(bucket.heard, true);
  assert.equal(bucket.quiet, PREVIEW_QUIET_MS - HANG_MS);
  assert.equal(bucket.quiet < QUIET_MS, true);
});

test("continuous speech previews before the recording ends", () => {
  const bucket = { heard: false, quiet: 0, elapsed: 0, chunkHeard: false, chunkQuiet: 0, chunkElapsed: 0 };
  assert.equal(noteCapture(bucket, 0.02, PREVIEW_CHUNK_MS), "preview");
  assert.equal(bucket.chunkElapsed, 0);
  assert.equal(noteCapture(bucket, 0.02, 200), "continue");
});

test("a quiet syllable still counts when the whole buffer looks silent", () => {
  const samples = new Float32Array(4096);
  for (let i = 2000; i < 2480; i += 1) samples[i] = 0.015;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const whole = Math.sqrt(sum / samples.length);
  assert.equal(whole < 0.008, true);
  assert.equal(frameLevel(samples) >= SPEECH_RMS, true);
});

test("recording ends after a real pause or at one minute", () => {
  const paused = { heard: true, quiet: QUIET_MS - 100, elapsed: 3000, chunkHeard: false, chunkQuiet: 0, chunkElapsed: 0 };
  assert.equal(noteCapture(paused, 0.001, 100), "finish");

  const talking = { heard: true, quiet: 2000, elapsed: 4000, chunkHeard: true, chunkQuiet: 0, chunkElapsed: 200 };
  assert.equal(noteCapture(talking, 0.02, 80), "continue");
  assert.equal(talking.quiet, 0);

  const long = { heard: false, quiet: 0, elapsed: 59000, chunkHeard: false, chunkQuiet: 0, chunkElapsed: 0 };
  assert.equal(noteCapture(long, 0.001, 1000), "finish");
});
