// @ts-check
/** Уровень, с которого буфер ещё считается речью. Среднее по всему буферу глушило тихие слоги. */
export const SPEECH_RMS = 0.006;
/** Ниже этого запись уже идёт и ждёт настоящую паузу, а не провал между слогами. */
export const SPEECH_HOLD_RMS = 0.003;
/** Короткая яма в громкости не копится в паузу конца фразы. */
export const HANG_MS = 400;
/** Пауза внутри фразы: кусок уже можно показать в поле, запись ещё не кончается. */
export const PREVIEW_QUIET_MS = 700;
/** Если паузы нет, всё равно показывать текст, не дожидаясь конца. */
export const PREVIEW_CHUNK_MS = 2500;
/** Пауза, после которой фраза отправляется. Короче срывает длинную реплику. */
export const QUIET_MS = 10000;
export const MAX_CAPTURE_MS = 60000;

/**
 * Громкость самого звучного куска, а не среднее по всему буферу.
 * @param {ArrayLike<number>} samples
 */
export function frameLevel(samples) {
  const frame = 480;
  const length = samples.length;
  if (!length) return 0;
  let peak = 0;
  for (let i = 0; i < length; i += frame) {
    const end = Math.min(i + frame, length);
    let sum = 0;
    for (let j = i; j < end; j += 1) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / (end - i));
    if (rms > peak) peak = rms;
  }
  return peak;
}

/**
 * @param {{ heard: boolean, quiet: number, elapsed: number, hang?: number, chunkHeard?: boolean, chunkQuiet?: number, chunkElapsed?: number }} bucket
 * @param {number} rms
 * @param {number} ms
 * @returns {"continue" | "preview" | "finish"}
 */
export function noteCapture(bucket, rms, ms) {
  bucket.elapsed += ms;
  bucket.chunkElapsed = (bucket.chunkElapsed || 0) + ms;
  const gate = bucket.heard ? SPEECH_HOLD_RMS : SPEECH_RMS;
  if (rms >= gate) {
    bucket.heard = true;
    bucket.chunkHeard = true;
    bucket.quiet = 0;
    bucket.chunkQuiet = 0;
    bucket.hang = HANG_MS;
  } else if (bucket.heard) {
    if (bucket.chunkHeard) bucket.chunkQuiet = (bucket.chunkQuiet || 0) + ms;
    const hang = bucket.hang || 0;
    if (hang >= ms) bucket.hang = hang - ms;
    else {
      bucket.quiet += ms - hang;
      bucket.hang = 0;
    }
  }
  if ((bucket.heard && bucket.quiet >= QUIET_MS) || bucket.elapsed >= MAX_CAPTURE_MS) return "finish";
  if (bucket.chunkHeard && ((bucket.chunkQuiet || 0) >= PREVIEW_QUIET_MS || (bucket.chunkElapsed || 0) >= PREVIEW_CHUNK_MS)) {
    bucket.chunkHeard = false;
    bucket.chunkQuiet = 0;
    bucket.chunkElapsed = 0;
    return "preview";
  }
  return "continue";
}
