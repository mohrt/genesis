import type { Sn76489 } from './sn76489';
import type { Ym2612 } from './ym2612';

/** The YM2612 makes a sample every 144 of its (the 68000's) clocks; the PSG steps every 16 Z80 clocks. */
const MASTER_PER_FM_SAMPLE = 144 * 7;
const MASTER_PER_PSG_TICK = 16 * 15;
/** One FM channel at full volume comes to a quarter of full scale; the PSG sits a little under it, as on the console. */
const FM_GAIN = 0.25 / 8192;
const PSG_GAIN = 0.15 / 4;
/** A gentle high-pass that takes away the chips' DC offset. */
const DC_BLOCK = 0.995;
/** The console's output is low-pass filtered; this takes the edge off at about 12 kHz. */
const LOW_PASS_HZ = 12_000;

/**
 * Runs the sound chips in step with the master clock and resamples their
 * mixed output to the audio device's rate, averaging the FM samples (each
 * with the PSG's average over it) that fall in each output sample.
 * Output is stereo, interleaved (left, right).
 */
export class AudioMixer {
  /** Master clocks into the current line the chips have been run to. */
  lineClock = 0;
  private fmPhase = 0;
  private psgPhase = 0;
  private samplesPerOutput = 1;
  private position = 0;
  private sumLeft = 0;
  private sumRight = 0;
  private count = 0;
  private lowPass = 1;
  private readonly smoothed = [0, 0];
  private readonly lastIn = [0, 0];
  private readonly lastOut = [0, 0];
  private buffer = new Float32Array(8192);
  private length = 0;

  constructor(
    private readonly psg: Sn76489,
    private readonly fm: Ym2612,
  ) {}

  setRates(masterHz: number, sampleRate: number): void {
    this.samplesPerOutput = masterHz / MASTER_PER_FM_SAMPLE / sampleRate;
    this.lowPass = 1 - Math.exp((-2 * Math.PI * LOW_PASS_HZ) / sampleRate);
  }

  /** Runs the chips up to `clock` master clocks into the line, e.g. before a CPU writes to one of them. */
  runTo(clock: number): void {
    if (clock <= this.lineClock) return;
    this.run(clock - this.lineClock);
    this.lineClock = clock;
  }

  /** Runs to the end of the line and starts counting the next one. */
  endLine(lineLength: number): void {
    this.runTo(lineLength);
    this.lineClock -= lineLength;
  }

  /** Advances the chips by `masterClocks`. */
  run(masterClocks: number): void {
    this.fmPhase += masterClocks;
    const { psg, fm } = this;
    while (this.fmPhase >= MASTER_PER_FM_SAMPLE) {
      this.fmPhase -= MASTER_PER_FM_SAMPLE;
      fm.tick();
      this.psgPhase += MASTER_PER_FM_SAMPLE;
      let psgSum = 0;
      let psgTicks = 0;
      while (this.psgPhase >= MASTER_PER_PSG_TICK) {
        this.psgPhase -= MASTER_PER_PSG_TICK;
        psg.tick();
        psgSum += psg.left;
        psgTicks++;
      }
      const psgLevel = psgTicks ? (psgSum / psgTicks) * PSG_GAIN : psg.left * PSG_GAIN;
      this.sumLeft += fm.left * FM_GAIN + psgLevel;
      this.sumRight += fm.right * FM_GAIN + psgLevel;
      this.count++;
      this.position++;
      if (this.position >= this.samplesPerOutput) {
        this.position -= this.samplesPerOutput;
        this.emit(this.sumLeft / this.count, this.sumRight / this.count);
        this.sumLeft = this.sumRight = this.count = 0;
      }
    }
  }

  private filter(channel: number, value: number): number {
    this.smoothed[channel] += (value - this.smoothed[channel]) * this.lowPass;
    const smoothed = this.smoothed[channel];
    const out = smoothed - this.lastIn[channel] + DC_BLOCK * this.lastOut[channel];
    this.lastIn[channel] = smoothed;
    this.lastOut[channel] = out;
    return out;
  }

  private emit(left: number, right: number): void {
    if (this.length + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = this.filter(0, left);
    this.buffer[this.length++] = this.filter(1, right);
  }

  /** The samples made since the last call, interleaved left and right. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
