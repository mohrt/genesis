import { describe, expect, it } from 'vitest';
import { Sn76489 } from '../src/sound/sn76489';
import { Ym2612 } from '../src/sound/ym2612';
import { AudioMixer } from '../src/sound/mixer';

/** Writes a register in the YM2612's first half (channels 1-3). */
const write = (ym: Ym2612, reg: number, value: number) => {
  ym.write(0, reg);
  ym.write(1, value);
};

/** Channel 1 as four operators all heard (algorithm 7), loud and with instant attack and release. */
function setUpChannel(ym: Ym2612): void {
  write(ym, 0xb0, 0x07);
  write(ym, 0xb4, 0xc0);
  for (const op of [0, 4, 8, 12]) {
    write(ym, 0x30 + op, 0x01);
    write(ym, 0x40 + op, 0x00);
    write(ym, 0x50 + op, 0x1f);
    write(ym, 0x60 + op, 0x00);
    write(ym, 0x70 + op, 0x00);
    write(ym, 0x80 + op, 0x0f);
  }
  write(ym, 0xa4, 0x24);
  write(ym, 0xa0, 0x3c);
}

function loudest(ym: Ym2612, samples: number): number {
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    ym.tick();
    peak = Math.max(peak, Math.abs(ym.left));
  }
  return peak;
}

describe('YM2612', () => {
  it('sounds a keyed-on channel and falls silent after key off', () => {
    const ym = new Ym2612();
    ym.reset();
    setUpChannel(ym);
    expect(loudest(ym, 500)).toBe(0);
    write(ym, 0x28, 0xf0);
    expect(loudest(ym, 2000)).toBeGreaterThan(4000);
    write(ym, 0x28, 0x00);
    loudest(ym, 4000);
    expect(loudest(ym, 500)).toBe(0);
  });

  it('plays the frequency it is given', () => {
    const ym = new Ym2612();
    ym.reset();
    setUpChannel(ym);
    // Only one operator heard: algorithm 7 with the others at full attenuation.
    for (const op of [0, 4, 8]) write(ym, 0x40 + op, 0x7f);
    write(ym, 0x28, 0xf0);
    let crossings = 0;
    let last = 0;
    const samples = 53_267;
    for (let i = 0; i < samples; i++) {
      ym.tick();
      if (last <= 0 && ym.left > 0) crossings++;
      if (ym.left !== 0) last = ym.left;
    }
    // F-number 0x43C in block 4 is 440 Hz (A4) at the NTSC clock.
    expect(crossings).toBeGreaterThan(430);
    expect(crossings).toBeLessThan(450);
  });

  it('plays the DAC on channel 6', () => {
    const ym = new Ym2612();
    ym.reset();
    write(ym, 0x2b, 0x80);
    write(ym, 0x2a, 0xff);
    ym.tick();
    expect(ym.left).toBe(127 << 6);
  });

  it('sets the timer flags when the timers overflow', () => {
    const ym = new Ym2612();
    ym.reset();
    write(ym, 0x24, 0xff);
    write(ym, 0x25, 0x02);
    write(ym, 0x26, 0xff);
    write(ym, 0x27, 0x0f);
    for (let i = 0; i < 3; i++) ym.tick();
    expect(ym.readStatus()).toBe(0x01);
    for (let i = 0; i < 16; i++) ym.tick();
    expect(ym.readStatus()).toBe(0x03);
    write(ym, 0x27, 0x3f);
    expect(ym.readStatus()).toBe(0x00);
  });
});

describe('mixer', () => {
  it('turns the chips into samples at the audio rate', () => {
    const psg = new Sn76489();
    const ym = new Ym2612();
    ym.reset();
    const mixer = new AudioMixer(psg, ym);
    mixer.setRates(53_693_175, 48_000);
    psg.write(0x80 | 0x0f);
    psg.write(0x10);
    psg.write(0x90);
    mixer.run(53_693_175 / 10);
    const samples = mixer.takeSamples();
    expect(samples.length / 2).toBeCloseTo(4800, -1);
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.01);
  });
});
