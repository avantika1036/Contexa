// FIFO of PCM sample chunks with a hard cap. Anything dropped to stay under the cap is counted,
// so audio loss is visible in the logs instead of silently producing missing words.
export class SampleQueue {
  constructor(maxSamples) {
    this.chunks = [];
    this.firstOffset = 0;
    this.totalSamples = 0;
    this.maxSamples = maxSamples;
    this.droppedSamples = 0;
  }

  push(samples) {
    if (!(samples instanceof Int16Array) || samples.length === 0) return;
    this.chunks.push(samples);
    this.totalSamples += samples.length;
    while (this.totalSamples > this.maxSamples && this.chunks.length > 1) {
      const first = this.chunks.shift();
      const available = first.length - this.firstOffset;
      this.totalSamples -= available;
      this.droppedSamples += available;
      this.firstOffset = 0;
    }
  }

  pull(count) {
    const output = new Int16Array(count); // Missing samples become silence, never ambient fallback audio.
    let written = 0;
    while (written < count && this.chunks.length > 0) {
      const first = this.chunks[0];
      const available = first.length - this.firstOffset;
      const take = Math.min(count - written, available);
      output.set(first.subarray(this.firstOffset, this.firstOffset + take), written);
      written += take;
      this.firstOffset += take;
      this.totalSamples -= take;
      if (this.firstOffset >= first.length) {
        this.chunks.shift();
        this.firstOffset = 0;
      }
    }
    return output;
  }
}
