/** Output level for each 4-bit attenuation: 2 dB per step, 15 = off. */
export const SN_VOLUMES: readonly number[] = Array.from({ length: 16 }, (_, i) => (i === 15 ? 0 : 10 ** (-i / 10)));

/** Sega's copy of the chip has a 16-bit noise shift register, fed back from bits 0 and 3. */
const NOISE_SEED = 0x8000;
const NOISE_TAPS = 0x0009;

/**
 * The sound part of Sega's video chips: a copy of the SN76489 with three
 * square-wave tone channels and a noise channel, each with 4-bit
 * attenuation. `tick` advances it one step of its internal clock (the CPU
 * clock divided by 16) and leaves the mixed level in `left` and `right`.
 *
 * Unlike TI's chip, a tone period of 0 or 1 holds the output high instead of
 * making a tone too high to hear, which games use to play samples through the
 * volume register. The Game Gear adds a stereo register (port $06) that
 * switches each channel on or off for each speaker.
 */
export class Sn76489 {
  /** 10-bit tone periods for channels 0-2. */
  readonly tones = new Uint16Array(3);
  /** Attenuation of channels 0-3 (15 = silent). */
  readonly volumes = new Uint8Array([15, 15, 15, 15]);
  readonly counters = new Uint16Array(4);
  /** Square-wave output of each channel (the noise channel's is the shift register's bit 0). */
  readonly outputs = new Uint8Array(4);
  /** Noise control: bit 2 = white noise, bits 1-0 = rate (3 = follow tone channel 2). */
  noise = 0;
  shifter = NOISE_SEED;
  /** The register selected by the last latch byte: channel * 2 + (1 for attenuation). */
  latch = 0;
  /** Game Gear stereo: bits 4-7 put channels 0-3 on the left, bits 0-3 on the right. */
  stereo = 0xff;
  /** The mixed level of the last tick for each speaker, 0 to 4. */
  left = 0;
  right = 0;

  reset(): void {
    this.tones.fill(0);
    this.volumes.fill(15);
    this.counters.fill(0);
    this.outputs.fill(0);
    this.noise = 0;
    this.shifter = NOISE_SEED;
    this.latch = 0;
    this.stereo = 0xff;
    this.left = this.right = 0;
  }

  write(value: number): void {
    if (value & 0x80) {
      this.latch = (value >> 4) & 0x07;
      this.writeLatched(value & 0x0f, true);
    } else {
      this.writeLatched(value, false);
    }
  }

  private writeLatched(data: number, low: boolean): void {
    const channel = this.latch >> 1;
    if (this.latch & 1) {
      this.volumes[channel] = data & 0x0f;
    } else if (channel === 3) {
      this.noise = data & 0x07;
      this.shifter = NOISE_SEED;
    } else if (low) {
      this.tones[channel] = (this.tones[channel] & 0x3f0) | (data & 0x0f);
    } else {
      this.tones[channel] = (this.tones[channel] & 0x00f) | ((data & 0x3f) << 4);
    }
  }

  /** Advances one internal clock (CPU clock / 16) and updates `left` and `right`. */
  tick(): void {
    const { counters, outputs, tones } = this;
    for (let channel = 0; channel < 3; channel++) {
      const period = tones[channel];
      if (period <= 1) {
        outputs[channel] = 1;
        continue;
      }
      if (counters[channel] > 0) counters[channel]--;
      if (counters[channel] === 0) {
        counters[channel] = period;
        outputs[channel] ^= 1;
      }
    }
    if (counters[3] > 0) counters[3]--;
    if (counters[3] === 0) {
      const rate = this.noise & 3;
      // The noise register shifts once per cycle of its square wave, so its period is doubled.
      counters[3] = (rate === 3 ? tones[2] || 1 : 0x10 << rate) * 2;
      this.shiftNoise();
    }
    outputs[3] = this.shifter & 1;
    const { volumes, stereo } = this;
    let left = 0;
    let right = 0;
    for (let channel = 0; channel < 4; channel++) {
      if (!outputs[channel]) continue;
      const level = SN_VOLUMES[volumes[channel]];
      if (stereo & (0x10 << channel)) left += level;
      if (stereo & (0x01 << channel)) right += level;
    }
    this.left = left;
    this.right = right;
  }

  private shiftNoise(): void {
    const s = this.shifter;
    let feedback: number;
    if (this.noise & 0x04) {
      const taps = s & NOISE_TAPS;
      feedback = (taps ^ (taps >> 3)) & 1;
    } else {
      feedback = s & 1;
    }
    this.shifter = (s >> 1) | (feedback << 15);
  }
}
