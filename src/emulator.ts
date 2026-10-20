import type { TvSystem } from './cart/detect';
import { Genesis, MASTER_PER_LINE } from './genesis';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;

/** Glues the machine to the screen and the speakers, and runs it in step with real time. */
export class Emulator {
  readonly machine = new Genesis();
  private clockDebt = 0;
  private audioRate = 48000;
  private idleShown = false;

  constructor(private readonly screen: Screen) {
    this.machine.onFrame = (frame, widths, lines) => screen.capture(frame, widths, lines);
    this.updateAudioRate();
  }

  get canRun(): boolean {
    return this.machine.canRun;
  }

  setAudioRate(rate: number): void {
    this.audioRate = rate;
    this.updateAudioRate();
  }

  setTv(tv: TvSystem): void {
    if (tv === this.machine.tv) return;
    this.machine.setTv(tv);
    this.updateAudioRate();
  }

  /** Follows the TV system of a restored save state. */
  restored(): void {
    this.updateAudioRate();
    this.resetTiming();
  }

  private updateAudioRate(): void {
    this.machine.audio.setRates(this.machine.clockHz, this.audioRate);
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.clockDebt = 0;
  }

  /** Runs the machine for `elapsedMs` of real time (no more than MAX_CATCH_UP_MS). */
  run(elapsedMs: number): void {
    if (!this.canRun) {
      if (!this.idleShown) this.screen.showIdle();
      this.idleShown = true;
      return;
    }
    this.idleShown = false;
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * this.machine.clockHz) / 1000;
    while (this.clockDebt >= MASTER_PER_LINE) {
      this.machine.runLine();
      this.clockDebt -= MASTER_PER_LINE;
    }
  }

  takeAudioSamples(): Float32Array {
    return this.machine.audio.takeSamples();
  }
}
