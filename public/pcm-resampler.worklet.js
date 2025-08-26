class PCMResampler extends AudioWorkletProcessor {
  constructor(opts) { super(); this.target = opts.processorOptions?.targetSampleRate || 24000; }
  process(inputs) {
    const ch = inputs?.[0]?.[0]; if (!ch) return true;
    const ratio = this.target / sampleRate;
    const outLen = Math.floor(ch.length * ratio);
    const out = new Int16Array(outLen);
    let acc = 0;
    for (let i = 0; i < outLen; i++) {
      const pos = acc | 0;
      const frac = acc - pos;
      const s0 = ch[pos] || 0, s1 = ch[pos + 1] || s0;
      const v = s0 + (s1 - s0) * frac; // linear interpolation
      out[i] = Math.max(-32768, Math.min(32767, (v * 32768) | 0));
      acc += 1 / ratio;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor('pcm-resampler', PCMResampler);
