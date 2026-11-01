/**
 * Measure one channel of interleaved stereo signed 16-bit little-endian PCM.
 * Returns signal levels only; it never exposes or stores audio samples.
 */
export function measurePcm16StereoChannel(buffer, channelIndex) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Node.js Buffer');
  if (channelIndex !== 0 && channelIndex !== 1) throw new RangeError('channelIndex must be 0 (left) or 1 (right)');

  const sampleCount = Math.floor(buffer.length / 4);
  if (sampleCount === 0) return { sampleCount: 0, rms: 0, peak: 0 };

  let sumSquares = 0;
  let peak = 0;
  const offset = channelIndex * 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = buffer.readInt16LE(index * 4 + offset);
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
    sumSquares += sample * sample;
  }
  return {
    sampleCount,
    rms: Math.round(Math.sqrt(sumSquares / sampleCount) * 10) / 10,
    peak,
  };
}

/** Existing capture gate, now factored so its input level can be logged/tested. */
export function isPcmChannelActive(metrics) {
  return metrics.rms >= 145 || (metrics.rms >= 65 && metrics.peak >= 900);
}
