// Fixed-point formats, as in the chip's well-studied emulations: phases are 16.16 (with a
// 10-bit sine index), envelopes are 10-bit attenuations in steps of 3/32 dB.
const FREQ_SH = 16;
const FREQ_MASK = (1 << FREQ_SH) - 1;
const ENV_BITS = 10;
const MAX_ATT = (1 << ENV_BITS) - 1;
const SIN_BITS = 10;
const SIN_LEN = 1 << SIN_BITS;
const SIN_MASK = SIN_LEN - 1;
const TL_RES_LEN = 256;
const TL_TAB_LEN = 13 * 2 * TL_RES_LEN;
/** Attenuations past this are silent. */
const ENV_QUIET = TL_TAB_LEN >> 3;
/** Phases wrap at 2^26 (16 fraction bits and the 10-bit sine index). */
const PHASE_MASK = 0x3ffffff;
/** Each channel's output is clipped to 14 bits. */
const CHANNEL_MAX = 8191;

const EG_OFF = 0;
const EG_REL = 1;
const EG_SUS = 2;
const EG_DEC = 3;
const EG_ATT = 4;

/** exp(-attenuation) as 13-bit amplitudes, with signs interleaved. */
const TL_TAB = new Int32Array(TL_TAB_LEN);
/** log(sin) of each phase step, as attenuation * 2 + sign. */
const SIN_TAB = new Uint32Array(SIN_LEN);
{
  const ENV_STEP = 128 / (1 << ENV_BITS);
  for (let x = 0; x < TL_RES_LEN; x++) {
    let n = Math.floor((1 << 16) / Math.pow(2, ((x + 1) * (ENV_STEP / 4)) / 8));
    n >>= 4;
    n = n & 1 ? (n >> 1) + 1 : n >> 1;
    n <<= 2;
    for (let i = 0; i < 13; i++) {
      TL_TAB[x * 2 + i * 2 * TL_RES_LEN] = n >> i;
      TL_TAB[x * 2 + 1 + i * 2 * TL_RES_LEN] = -(n >> i);
    }
  }
  for (let i = 0; i < SIN_LEN; i++) {
    const m = Math.sin(((i * 2 + 1) * Math.PI) / SIN_LEN);
    const o = ((8 * Math.log(1 / Math.abs(m))) / Math.log(2)) / (ENV_STEP / 4);
    let n = Math.floor(2 * o);
    n = n & 1 ? (n >> 1) + 1 : n >> 1;
    SIN_TAB[i] = n * 2 + (m >= 0 ? 0 : 1);
  }
}

/** Envelope increments: 8 steps for each of the rate patterns. */
const EG_INC = Uint8Array.from([
  0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 8, 4, 8, 4, 8, 4, 8, 4, 8, 4, 8, 8, 8, 4, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 16, 16, 16, 16, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const PATTERN_INSTANT = 17 * 8;
const PATTERN_NEVER = 18 * 8;

/** For each of the 128 rate indices (32 never, 64 real rates, 32 beyond): which pattern, and how often it steps. */
const EG_RATE_SELECT = new Uint8Array(128);
const EG_RATE_SHIFT = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const rate = i - 32;
  if (rate < 0) {
    EG_RATE_SELECT[i] = PATTERN_NEVER;
  } else if (rate < 48) {
    // Rates 0 and 1 never step; 2-3 and 4-7 step slowly, like the rates above.
    let pattern = rate & 3;
    if (rate < 2) pattern = 18;
    else if (rate < 4) pattern = 0;
    else if (rate < 8) pattern = rate < 6 ? 0 : 2;
    EG_RATE_SELECT[i] = pattern * 8;
    EG_RATE_SHIFT[i] = 11 - (rate >> 2);
  } else if (rate < 60) {
    EG_RATE_SELECT[i] = (4 + (rate - 48)) * 8;
  } else {
    EG_RATE_SELECT[i] = 16 * 8;
  }
}

/** Key codes for the top four bits of an 11-bit frequency number. */
const FK_TABLE = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3];

/** Detune, in phase steps, for each of the 4 detune amounts and 32 key codes. */
const DT_BASE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8],
  [1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16],
  [2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22],
];
const DT_TAB: Int32Array[] = Array.from({ length: 8 }, (_, d) =>
  Int32Array.from(DT_BASE[d & 3], (value) => (d & 4 ? -1 : 1) * value * 64),
);

/** Sustain levels: 3 dB steps, the last one all the way down. */
const SL_TABLE = Array.from({ length: 16 }, (_, i) => (i === 15 ? 31 : i) * 32);
/** Phase increments for frequency numbers at block 7 (doubled, for the LFO's finer steps). */
const FN_TABLE = Uint32Array.from({ length: 4096 }, (_, i) => i * 32 * 64);
const FN_MAX = 0x20000 * 64;

/** LFO steps: samples per step for each of the 8 LFO frequencies. */
const LFO_SAMPLES_PER_STEP = [108, 77, 71, 67, 62, 44, 8, 5];
/** AM depth shifts for the 4 AMS settings (0, 1.4, 5.9 and 11.8 dB). */
const LFO_AMS_SHIFT = [8, 3, 1, 0];

/** Frequency offsets for LFO vibrato: for each depth, the top 7 bits of the frequency number and the 32 LFO steps. */
const LFO_PM_TABLE = new Int8Array(128 * 8 * 32);
{
  const pattern = (k: number): number[] => {
    if (k <= 0) return [0, 0, 0, 0, 0, 0, 0, 0];
    if (k === 1) return [0, 0, 0, 0, 1, 1, 1, 1];
    if (k === 2) return [0, 0, 1, 1, 2, 2, 2, 3];
    return [0, 0, 2, 3, 4, 4, 5, 6].map((value) => value << (k - 3));
  };
  for (let depth = 0; depth < 8; depth++) {
    for (let fnum = 0; fnum < 128; fnum++) {
      for (let step = 0; step < 8; step++) {
        let value = 0;
        for (let bit = 0; bit < 7; bit++) if (fnum & (1 << bit)) value += pattern(depth + bit - 6)[step];
        const at = fnum * 256 + depth * 32;
        LFO_PM_TABLE[at + step] = value;
        LFO_PM_TABLE[at + (step ^ 7) + 8] = value;
        LFO_PM_TABLE[at + step + 16] = -value;
        LFO_PM_TABLE[at + (step ^ 7) + 24] = -value;
      }
    }
  }
}

function opCalc(phase: number, env: number, pm: number): number {
  const p = (env << 3) + SIN_TAB[(((phase & ~FREQ_MASK) + pm) >> FREQ_SH) & SIN_MASK];
  return p >= TL_TAB_LEN ? 0 : TL_TAB[p];
}

/** One of a channel's four operators. */
class Operator {
  /** Detune table, set by register $30. */
  dt = 0;
  /** Multiple * 2 (0 means 1/2). */
  mul = 1;
  /** Total level, as an attenuation. */
  tl = 0;
  /** Key scale shift: the key code is shifted right by this much. */
  ksShift = 3;
  ar = 0;
  d1r = 0;
  d2r = 0;
  rr = 0;
  sl = 0;
  am = false;
  ssg = 0;
  /** SSG-EG's inversion state (4 when inverted). */
  ssgn = 0;
  ksr = -1;
  state = EG_OFF;
  volume = MAX_ATT;
  volOut = MAX_ATT;
  key = false;
  phase = 0;
  increment = 0;
  shAr = 0;
  selAr = PATTERN_NEVER;
  shD1r = 0;
  selD1r = PATTERN_NEVER;
  shD2r = 0;
  selD2r = PATTERN_NEVER;
  shRr = 0;
  selRr = PATTERN_NEVER;

  refreshRates(): void {
    // Until the channel's frequency is next worked out, the key scaling is unknown (-1).
    const ksr = Math.max(0, this.ksr);
    if (this.ar + ksr < 32 + 62) {
      this.shAr = EG_RATE_SHIFT[this.ar + ksr];
      this.selAr = EG_RATE_SELECT[this.ar + ksr];
    } else {
      this.shAr = 0;
      this.selAr = PATTERN_INSTANT;
    }
    this.shD1r = EG_RATE_SHIFT[this.d1r + ksr];
    this.selD1r = EG_RATE_SELECT[this.d1r + ksr];
    this.shD2r = EG_RATE_SHIFT[this.d2r + ksr];
    this.selD2r = EG_RATE_SELECT[this.d2r + ksr];
    this.shRr = EG_RATE_SHIFT[this.rr + ksr];
    this.selRr = EG_RATE_SELECT[this.rr + ksr];
  }

  /** Sets the phase increment from the channel's frequency and key code. */
  refreshFrequency(fc: number, kc: number): void {
    let frequency = fc + DT_TAB[this.dt][kc];
    if (frequency < 0) frequency += FN_MAX;
    this.increment = (frequency * this.mul) >>> 1;
    const ksr = kc >> this.ksShift;
    if (ksr !== this.ksr) {
      this.ksr = ksr;
      this.refreshRates();
    }
  }

  keyOn(): void {
    if (this.key) return;
    this.key = true;
    this.phase = 0;
    this.ssgn = 0;
    if (this.ar + Math.max(0, this.ksr) < 32 + 62) {
      this.state = EG_ATT;
    } else {
      this.volume = 0;
      this.state = this.sl === 0 ? EG_SUS : EG_DEC;
    }
    this.updateVolOut();
  }

  keyOff(): void {
    if (!this.key) return;
    this.key = false;
    if (this.state > EG_REL) {
      this.state = EG_REL;
      // An inverted SSG-EG envelope is released from where it is heard.
      if (this.ssg & 0x08 && this.ssgn ^ (this.ssg & 0x04)) this.volume = (0x200 - this.volume) & MAX_ATT;
      this.ssgn = 0;
      this.updateVolOut();
    }
  }

  updateVolOut(): void {
    if (this.ssg & 0x08 && this.ssgn ^ (this.ssg & 0x04) && this.state > EG_REL) {
      this.volOut = ((0x200 - this.volume) & MAX_ATT) + this.tl;
    } else {
      this.volOut = this.volume + this.tl;
    }
  }

  /** One step of the envelope generator (every 3 samples). */
  advanceEnvelope(counter: number): void {
    switch (this.state) {
      case EG_ATT:
        if (!(counter & ((1 << this.shAr) - 1))) {
          this.volume += (~this.volume * EG_INC[this.selAr + ((counter >> this.shAr) & 7)]) >> 4;
          if (this.volume <= 0) {
            this.volume = 0;
            this.state = this.sl === 0 ? EG_SUS : EG_DEC;
          }
        }
        break;
      case EG_DEC:
        if (!(counter & ((1 << this.shD1r) - 1))) {
          const step = EG_INC[this.selD1r + ((counter >> this.shD1r) & 7)];
          this.volume += this.ssg & 0x08 ? (this.volume < 0x200 ? 4 * step : 0) : step;
          if (this.volume >= this.sl) this.state = EG_SUS;
        }
        break;
      case EG_SUS:
        if (!(counter & ((1 << this.shD2r) - 1))) {
          const step = EG_INC[this.selD2r + ((counter >> this.shD2r) & 7)];
          if (this.ssg & 0x08) {
            if (this.volume < 0x200) this.volume += 4 * step;
          } else {
            this.volume = Math.min(MAX_ATT, this.volume + step);
          }
        }
        break;
      case EG_REL:
        if (!(counter & ((1 << this.shRr) - 1))) {
          const step = EG_INC[this.selRr + ((counter >> this.shRr) & 7)];
          this.volume += this.ssg & 0x08 ? (this.volume < 0x200 ? 4 * step : 0) : step;
          if (this.volume >= MAX_ATT || (this.ssg & 0x08 && this.volume >= 0x200)) {
            this.volume = MAX_ATT;
            this.state = EG_OFF;
          }
        }
        break;
    }
    this.updateVolOut();
  }

  /** SSG-EG: at the bottom of its envelope an operator repeats, holds, or flips, as its mode says. */
  updateSsg(): void {
    if (!(this.ssg & 0x08) || this.volume < 0x200 || this.state <= EG_REL) return;
    if (this.ssg & 0x01) {
      if (this.ssg & 0x02) this.ssgn = 4;
      if (this.state !== EG_ATT && !(this.ssgn ^ (this.ssg & 0x04))) this.volume = MAX_ATT;
    } else {
      if (this.ssg & 0x02) this.ssgn ^= 4;
      else this.phase = 0;
      if (this.state !== EG_ATT) {
        if (this.ar + this.ksr < 32 + 62) {
          this.state = EG_ATT;
        } else {
          this.volume = 0;
          this.state = this.sl === 0 ? EG_SUS : EG_DEC;
        }
      }
    }
    this.updateVolOut();
  }
}

class Channel {
  /** Operators in register order: S1, S3, S2, S4. */
  readonly ops = [new Operator(), new Operator(), new Operator(), new Operator()];
  algorithm = 0;
  /** Feedback as a shift (0 for none). */
  feedback = 0;
  /** The last two outputs of operator 1, for feedback. */
  op1Out0 = 0;
  op1Out1 = 0;
  /** The delayed sample some algorithms pass on to the next one. */
  memory = 0;
  left = true;
  right = true;
  ams = LFO_AMS_SHIFT[0];
  /** The vibrato depth's offset into LFO_PM_TABLE. */
  pms = 0;
  fc = 0;
  kcode = 0;
  /** Block and frequency number: block in bits 13-11. */
  blockFnum = 0;
  /** The frequencies have changed and the operators' increments need working out. */
  dirty = true;
}

/** The order the operators are wired: S1, S2, S3, S4 in terms of the register order S1, S3, S2, S4. */
const S1 = 0;
const S3 = 1;
const S2 = 2;
const S4 = 3;

/**
 * Yamaha's YM2612 (OPN2): six FM channels of four operators, eight
 * algorithms, feedback, the envelope generator with its rates and key
 * scaling, detune and multiple, the LFO's tremolo and vibrato, channel 3's
 * separate operator frequencies, SSG-EG envelopes, the DAC on channel 6, and
 * timers A and B. `tick` makes one sample at the chip's own rate (its clock
 * divided by 144) and leaves it in `left` and `right`.
 */
export class Ym2612 {
  readonly channels = Array.from({ length: 6 }, () => new Channel());
  /** Selected register addresses for each half (channels 1-3, 4-6). */
  readonly addresses = new Uint8Array(2);
  /** The frequency high byte latches: channels' and channel 3's operators'. */
  fnHigh = 0;
  ch3FnHigh = 0;
  readonly ch3Fc = new Int32Array(3);
  readonly ch3Kcode = new Uint8Array(3);
  readonly ch3BlockFnum = new Uint16Array(3);
  /** Register $27: channel 3 mode in bits 7-6, timer control below. */
  mode = 0;
  timerA = 0;
  timerB = 0;
  timerACount = 0;
  timerBCount = 0;
  status = 0;
  egCounter = 1;
  egTimer = 0;
  lfoEnabled = false;
  lfoPeriod = 0;
  lfoTimer = 0;
  lfoCount = 0;
  lfoAm = 126;
  lfoPm = 0;
  dacEnabled = false;
  dacData = 0;
  left = 0;
  right = 0;

  reset(): void {
    for (const channel of this.channels) {
      for (const op of channel.ops) {
        Object.assign(op, new Operator());
      }
      Object.assign(channel, { ...new Channel(), ops: channel.ops });
    }
    this.addresses.fill(0);
    this.fnHigh = this.ch3FnHigh = 0;
    this.ch3Fc.fill(0);
    this.ch3Kcode.fill(0);
    this.ch3BlockFnum.fill(0);
    this.mode = this.timerA = this.timerB = this.timerACount = this.timerBCount = this.status = 0;
    this.egCounter = 1;
    this.egTimer = 0;
    this.lfoEnabled = false;
    this.lfoPeriod = this.lfoTimer = this.lfoCount = 0;
    this.lfoAm = 126;
    this.lfoPm = 0;
    this.dacEnabled = false;
    this.dacData = 0;
    this.left = this.right = 0;
    for (let reg = 0xb4; reg <= 0xb6; reg++) {
      this.writeRegister(0, reg, 0xc0);
      this.writeRegister(1, reg, 0xc0);
    }
  }

  /** The status read at any port: timer flags in bits 1-0 (the busy flag is never seen set). */
  readStatus(): number {
    return this.status;
  }

  /** A write to port 0-3: even ports select a register of their half, odd ones write it. */
  write(port: number, value: number): void {
    const half = (port >> 1) & 1;
    if (!(port & 1)) {
      this.addresses[half] = value;
      return;
    }
    const reg = this.addresses[half];
    // Registers below $30 only exist in the first half.
    if (half === 1 && reg < 0x30) return;
    this.writeRegister(half, reg, value);
  }

  private writeRegister(half: number, reg: number, value: number): void {
    if (reg < 0x30) {
      this.writeGlobal(reg, value);
      return;
    }
    const channelIndex = reg & 3;
    if (channelIndex === 3) return;
    const channel = this.channels[half * 3 + channelIndex];
    if (reg < 0xa0) {
      this.writeOperator(channel, channel.ops[(reg >> 2) & 3], reg & 0xf0, value);
      return;
    }
    switch (reg & 0xfc) {
      case 0xa0: {
        const fn = ((this.fnHigh & 7) << 8) | value;
        const block = this.fnHigh >> 3;
        channel.kcode = (block << 2) | FK_TABLE[fn >> 7];
        channel.fc = FN_TABLE[fn * 2] >> (7 - block);
        channel.blockFnum = (block << 11) | fn;
        channel.dirty = true;
        break;
      }
      case 0xa4:
        this.fnHigh = value & 0x3f;
        break;
      case 0xa8:
        if (half === 0) {
          const fn = ((this.ch3FnHigh & 7) << 8) | value;
          const block = this.ch3FnHigh >> 3;
          this.ch3Kcode[channelIndex] = (block << 2) | FK_TABLE[fn >> 7];
          this.ch3Fc[channelIndex] = FN_TABLE[fn * 2] >> (7 - block);
          this.ch3BlockFnum[channelIndex] = (block << 11) | fn;
          this.channels[2].dirty = true;
        }
        break;
      case 0xac:
        if (half === 0) this.ch3FnHigh = value & 0x3f;
        break;
      case 0xb0: {
        channel.algorithm = value & 7;
        const feedback = (value >> 3) & 7;
        channel.feedback = feedback ? feedback + 6 : 0;
        break;
      }
      case 0xb4:
        channel.left = (value & 0x80) !== 0;
        channel.right = (value & 0x40) !== 0;
        channel.ams = LFO_AMS_SHIFT[(value >> 4) & 3];
        channel.pms = (value & 7) * 32;
        break;
    }
  }

  private writeGlobal(reg: number, value: number): void {
    switch (reg) {
      case 0x22:
        this.lfoEnabled = (value & 0x08) !== 0;
        this.lfoPeriod = LFO_SAMPLES_PER_STEP[value & 7];
        if (!this.lfoEnabled) {
          this.lfoCount = this.lfoTimer = 0;
          this.lfoAm = 126;
          this.lfoPm = 0;
        }
        break;
      case 0x24:
        this.timerA = (this.timerA & 0x03) | (value << 2);
        break;
      case 0x25:
        this.timerA = (this.timerA & 0x3fc) | (value & 3);
        break;
      case 0x26:
        this.timerB = value;
        break;
      case 0x27: {
        if (value & 0x01 && !(this.mode & 0x01)) this.timerACount = 1024 - this.timerA;
        if (value & 0x02 && !(this.mode & 0x02)) this.timerBCount = (256 - this.timerB) << 4;
        if (value & 0x10) this.status &= ~0x01;
        if (value & 0x20) this.status &= ~0x02;
        if ((value ^ this.mode) & 0xc0) this.channels[2].dirty = true;
        this.mode = value;
        break;
      }
      case 0x28: {
        const index = value & 3;
        if (index === 3) break;
        const channel = this.channels[(value & 4 ? 3 : 0) + index];
        const slots = [0x10, 0x40, 0x20, 0x80];
        channel.ops.forEach((op, i) => (value & slots[i] ? op.keyOn() : op.keyOff()));
        break;
      }
      case 0x2a:
        this.dacData = value;
        break;
      case 0x2b:
        this.dacEnabled = (value & 0x80) !== 0;
        break;
    }
  }

  private writeOperator(channel: Channel, op: Operator, reg: number, value: number): void {
    switch (reg) {
      case 0x30:
        op.dt = (value >> 4) & 7;
        op.mul = value & 0x0f ? (value & 0x0f) * 2 : 1;
        channel.dirty = true;
        break;
      case 0x40:
        op.tl = (value & 0x7f) << (ENV_BITS - 7);
        op.updateVolOut();
        break;
      case 0x50:
        op.ksShift = 3 - (value >> 6);
        op.ar = value & 0x1f ? 32 + ((value & 0x1f) << 1) : 0;
        channel.dirty = true;
        op.ksr = -1;
        break;
      case 0x60:
        op.am = (value & 0x80) !== 0;
        op.d1r = value & 0x1f ? 32 + ((value & 0x1f) << 1) : 0;
        op.refreshRates();
        break;
      case 0x70:
        op.d2r = value & 0x1f ? 32 + ((value & 0x1f) << 1) : 0;
        op.refreshRates();
        break;
      case 0x80:
        op.sl = SL_TABLE[value >> 4];
        op.rr = 34 + ((value & 0x0f) << 2);
        op.refreshRates();
        break;
      case 0x90:
        op.ssg = value & 0x0f;
        op.updateVolOut();
        break;
    }
  }

  private refreshChannel(index: number): void {
    const channel = this.channels[index];
    if (!channel.dirty) return;
    channel.dirty = false;
    const ops = channel.ops;
    if (index === 2 && this.mode & 0xc0) {
      ops[S1].refreshFrequency(this.ch3Fc[1], this.ch3Kcode[1]);
      ops[S2].refreshFrequency(this.ch3Fc[2], this.ch3Kcode[2]);
      ops[S3].refreshFrequency(this.ch3Fc[0], this.ch3Kcode[0]);
      ops[S4].refreshFrequency(channel.fc, channel.kcode);
    } else {
      for (const op of ops) op.refreshFrequency(channel.fc, channel.kcode);
    }
  }

  private advanceTimers(): void {
    if (this.mode & 0x01 && --this.timerACount <= 0) {
      this.timerACount = 1024 - this.timerA;
      if (this.mode & 0x04) this.status |= 0x01;
      // CSM mode keys channel 3's operators on at each timer A overflow.
      if ((this.mode & 0xc0) === 0x80) {
        for (const op of this.channels[2].ops) {
          op.keyOn();
          op.keyOff();
        }
      }
    }
    if (this.mode & 0x02 && --this.timerBCount <= 0) {
      this.timerBCount = (256 - this.timerB) << 4;
      if (this.mode & 0x08) this.status |= 0x02;
    }
  }

  private advanceLfo(): void {
    if (!this.lfoEnabled) return;
    if (++this.lfoTimer < this.lfoPeriod) return;
    this.lfoTimer = 0;
    this.lfoCount = (this.lfoCount + 1) & 127;
    this.lfoAm = this.lfoCount < 64 ? (this.lfoCount ^ 63) << 1 : (this.lfoCount & 63) << 1;
    this.lfoPm = this.lfoCount >> 2;
  }

  /** Advances the phases of a channel's operators, with vibrato if the LFO is on. */
  private advancePhases(channel: Channel, index: number): void {
    const ops = channel.ops;
    if (this.lfoEnabled && channel.pms) {
      const special = index === 2 && (this.mode & 0xc0) !== 0;
      for (let i = 0; i < 4; i++) {
        const op = ops[i];
        const blockFnum = special && i !== S4 ? this.ch3BlockFnum[i === S1 ? 1 : i === S2 ? 2 : 0] : channel.blockFnum;
        const offset = LFO_PM_TABLE[((blockFnum & 0x7f0) >> 4) * 256 + channel.pms + this.lfoPm];
        if (!offset) {
          op.phase = (op.phase + op.increment) & PHASE_MASK;
          continue;
        }
        const shifted = blockFnum * 2 + offset;
        const block = (shifted & 0x7000) >> 12;
        const fn = shifted & 0xfff;
        const kc = (block << 2) | FK_TABLE[fn >> 8];
        let frequency = (FN_TABLE[fn] >> (7 - block)) + DT_TAB[op.dt][kc];
        if (frequency < 0) frequency += FN_MAX;
        op.phase = (op.phase + ((frequency * op.mul) >>> 1)) & PHASE_MASK;
      }
      return;
    }
    for (let i = 0; i < 4; i++) ops[i].phase = (ops[i].phase + ops[i].increment) & PHASE_MASK;
  }

  /** The channel's output for this sample: its operators combined by its algorithm. */
  private channelOutput(channel: Channel): number {
    const ops = channel.ops;
    const am = this.lfoAm >> channel.ams;
    const env = (op: Operator) => op.volOut + (op.am ? am : 0);
    let m2 = 0;
    let c1 = 0;
    let c2 = 0;
    let mem = 0;
    let out = 0;
    const algorithm = channel.algorithm;
    // The sample delayed from last time goes to operator 3's or 4's input.
    if (algorithm <= 2) m2 = channel.memory;
    else if (algorithm === 3) c2 = channel.memory;

    const feedbackInput = channel.op1Out0 + channel.op1Out1;
    channel.op1Out0 = channel.op1Out1;
    const op1 = channel.op1Out0;
    switch (algorithm) {
      case 0:
      case 3:
      case 4:
      case 6:
        c1 += op1;
        break;
      case 1:
        mem += op1;
        break;
      case 2:
        c2 += op1;
        break;
      case 5:
        mem = c1 = c2 = op1;
        break;
      default:
        out += op1;
        break;
    }
    channel.op1Out1 = 0;
    const env1 = env(ops[S1]);
    if (env1 < ENV_QUIET) {
      const modulation = channel.feedback ? feedbackInput << channel.feedback : 0;
      channel.op1Out1 = opCalc(ops[S1].phase, env1, modulation);
    }

    const env3 = env(ops[S3]);
    if (env3 < ENV_QUIET) {
      const value = opCalc(ops[S3].phase, env3, m2 << 15);
      if (algorithm >= 5) out += value;
      else c2 += value;
    }
    const env2 = env(ops[S2]);
    if (env2 < ENV_QUIET) {
      const value = opCalc(ops[S2].phase, env2, c1 << 15);
      if (algorithm >= 4) out += value;
      else mem += value;
    }
    const env4 = env(ops[S4]);
    if (env4 < ENV_QUIET) out += opCalc(ops[S4].phase, env4, c2 << 15);
    channel.memory = mem;
    return Math.max(-CHANNEL_MAX - 1, Math.min(CHANNEL_MAX, out));
  }

  /** Makes one sample (both speakers, each channel up to ±8192). */
  tick(): void {
    this.advanceLfo();
    let left = 0;
    let right = 0;
    for (let i = 0; i < 6; i++) {
      const channel = this.channels[i];
      this.refreshChannel(i);
      let output: number;
      if (i === 5 && this.dacEnabled) output = (this.dacData - 128) << 6;
      else output = this.channelOutput(channel);
      if (channel.left) left += output;
      if (channel.right) right += output;
      this.advancePhases(channel, i);
    }
    this.left = left;
    this.right = right;

    if (++this.egTimer >= 3) {
      this.egTimer = 0;
      const counter = this.egCounter;
      this.egCounter = (counter + 1) & 0xfff || 1;
      for (const channel of this.channels) {
        for (const op of channel.ops) {
          op.updateSsg();
          op.advanceEnvelope(counter);
        }
      }
    }
    this.advanceTimers();
  }
}
