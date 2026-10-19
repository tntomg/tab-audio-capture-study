// worklet-processor.js — AudioWorkletProcessor «pcm-collector».
// Живёт в АУДИО-ПОТОКЕ рендера (не в главном потоке!): поэтому провалов
// (тишина посередине, треск) не бывает, даже если главный поток занят или
// вкладка в фоне. Собирает стерео-PCM блоками по 8192 фреймов и передаёт
// Int16-блоки в главный поток офскрин-документа; звук при этом проходит
// насквозь (pass-through) — пользователь слышит запись в колонках.
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this._block = 8192; // ~170 мс @ 48 кГц
    this._l = new Float32Array(this._block);
    this._r = new Float32Array(this._block);
    this._fill = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const inL = input && input[0];
    const inR = input && (input.length > 1 ? input[1] : input[0]); // моно -> дублируем
    const output = outputs[0];

    // pass-through: копируем вход на выход, чтобы звук продолжал звучать
    // (во время tabCapture вкладка сама молчит — её вывод переходит нам)
    if (output && inL) {
      const outL = output[0];
      outL.set(inL);
      if (output.length > 1 && inR && output[1] !== outL) {
        output[1].set(inR);
      }
    }

    if (inL && inR) {
      let src = 0;
      const n = inL.length;
      while (src < n) {
        const take = Math.min(n - src, this._block - this._fill);
        this._l.set(inL.subarray(src, src + take), this._fill);
        this._r.set(inR.subarray(src, src + take), this._fill);
        this._fill += take;
        src += take;
        if (this._fill === this._block) this._flush();
      }
    }
    return true; // держим узел живым
  }

  _flush() {
    const l = new Int16Array(this._block);
    const r = new Int16Array(this._block);
    let peak = 0;
    for (let i = 0; i < this._block; i++) {
      let a = this._l[i];
      let b = this._r[i];
      if (a > 1) a = 1; else if (a < -1) a = -1;
      if (b > 1) b = 1; else if (b < -1) b = -1;
      l[i] = a < 0 ? a * 0x8000 : a * 0x7fff;
      r[i] = b < 0 ? b * 0x8000 : b * 0x7fff;
      const av = a < 0 ? -a : a;
      if (av > peak) peak = av;
    }
    this._fill = 0;
    this.port.postMessage({ l, r, peak }, [l.buffer, r.buffer]);
  }
}

registerProcessor('pcm-collector', PcmCollector);
