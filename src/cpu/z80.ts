/** What the Z80 sees of the machine: memory and the I/O ports. */
export interface Z80Bus {
  read(address: number): number;
  write(address: number, value: number): void;
  /** `port` is the full 16-bit address the Z80 puts out (A15-A8 is B or A, depending on the instruction). */
  input(port: number): number;
  output(port: number, value: number): void;
}

export const FLAG_C = 0x01;
export const FLAG_N = 0x02;
export const FLAG_PV = 0x04;
export const FLAG_X = 0x08;
export const FLAG_H = 0x10;
export const FLAG_Y = 0x20;
export const FLAG_Z = 0x40;
export const FLAG_S = 0x80;
const FLAGS_XY = FLAG_X | FLAG_Y;
const FLAGS_SZPV = FLAG_S | FLAG_Z | FLAG_PV;

/** Sign, zero and the undocumented bits 5 and 3 of each byte value. */
const SZ53 = new Uint8Array(256);
/** As SZ53, plus parity in P/V. */
const SZ53P = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ53[i] = (i & (FLAG_S | FLAGS_XY)) | (i === 0 ? FLAG_Z : 0);
  let bits = i;
  bits ^= bits >> 4;
  bits ^= bits >> 2;
  bits ^= bits >> 1;
  SZ53P[i] = SZ53[i] | (bits & 1 ? 0 : FLAG_PV);
}

/** Interrupt modes 0-2 for the IM instructions at ED 46/4E/56/5E/66/6E/76/7E. */
const IM_MODES = [0, 0, 1, 2, 0, 0, 1, 2];

/** Which register pair stands in for HL: none, IX (after DD) or IY (after FD). */
const Index = { HL: 0, IX: 1, IY: 2 } as const;
type Index = (typeof Index)[keyof typeof Index];

const signed = (byte: number) => (byte & 0x80 ? byte - 256 : byte);

/**
 * A Zilog Z80, instruction-stepped with exact T-state counts. Covers every
 * documented and undocumented opcode, the undocumented flag bits 5 and 3, the
 * hidden MEMPTR (WZ) register they leak through, the R register, the three
 * interrupt modes, NMI, HALT and the one-instruction delay after EI.
 */
export class Z80 {
  a = 0xff;
  f = 0xff;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  /** The alternate register set (AF', BC', DE', HL'). */
  a2 = 0;
  f2 = 0;
  b2 = 0;
  c2 = 0;
  d2 = 0;
  e2 = 0;
  h2 = 0;
  l2 = 0;
  ix = 0xffff;
  iy = 0xffff;
  sp = 0xffff;
  pc = 0;
  i = 0;
  r = 0;
  iff1 = false;
  iff2 = false;
  im = 0;
  halted = false;
  memptr = 0;
  /** The INT line, held low (true) by a device wanting an interrupt. */
  irq = false;
  /** What a device puts on the data bus when an interrupt is acknowledged (an opcode in IM 0, the vector's low byte in IM 2). */
  irqData = 0xff;
  /** T-states run since power on. */
  cycles = 0;
  private nmiPending = false;
  private eiDelay = false;
  private index: Index = Index.HL;
  /** T-states of the instruction being executed. */
  private t = 0;

  constructor(private readonly bus: Z80Bus) {}

  reset(): void {
    this.pc = 0;
    this.i = this.r = 0;
    this.iff1 = this.iff2 = false;
    this.im = 0;
    this.halted = false;
    this.nmiPending = false;
    this.eiDelay = false;
    this.a = this.f = 0xff;
    this.sp = 0xffff;
  }

  /** Signals a non-maskable interrupt (the NMI line going low). */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Runs one instruction (or accepts an interrupt) and returns the T-states it took. */
  step(): number {
    this.t = 0;
    if (this.nmiPending) {
      this.nmiPending = false;
      this.acceptNmi();
    } else if (this.irq && this.iff1 && !this.eiDelay) {
      this.acceptInterrupt();
    } else {
      this.eiDelay = false;
      if (this.halted) {
        this.incrementR();
        this.t = 4;
      } else {
        this.executeNext();
      }
    }
    this.cycles += this.t;
    return this.t;
  }

  /** Runs instructions for at least `budget` T-states; returns how many were run. */
  run(budget: number): number {
    let done = 0;
    while (done < budget) done += this.step();
    return done;
  }

  // --- Register pairs -----------------------------------------------------------

  get af(): number {
    return (this.a << 8) | this.f;
  }
  set af(value: number) {
    this.a = (value >> 8) & 0xff;
    this.f = value & 0xff;
  }
  get bc(): number {
    return (this.b << 8) | this.c;
  }
  set bc(value: number) {
    this.b = (value >> 8) & 0xff;
    this.c = value & 0xff;
  }
  get de(): number {
    return (this.d << 8) | this.e;
  }
  set de(value: number) {
    this.d = (value >> 8) & 0xff;
    this.e = value & 0xff;
  }
  get hl(): number {
    return (this.h << 8) | this.l;
  }
  set hl(value: number) {
    this.h = (value >> 8) & 0xff;
    this.l = value & 0xff;
  }

  /** HL, IX or IY, depending on the prefix of the current instruction. */
  private get xy(): number {
    return this.index === Index.HL ? this.hl : this.index === Index.IX ? this.ix : this.iy;
  }
  private set xy(value: number) {
    value &= 0xffff;
    if (this.index === Index.HL) this.hl = value;
    else if (this.index === Index.IX) this.ix = value;
    else this.iy = value;
  }

  /** BC, DE, HL (or IX/IY), SP: the `rp` operand of the instruction encoding. */
  private getRp(p: number): number {
    switch (p) {
      case 0:
        return this.bc;
      case 1:
        return this.de;
      case 2:
        return this.xy;
      default:
        return this.sp;
    }
  }
  private setRp(p: number, value: number): void {
    switch (p) {
      case 0:
        this.bc = value;
        break;
      case 1:
        this.de = value;
        break;
      case 2:
        this.xy = value;
        break;
      default:
        this.sp = value & 0xffff;
    }
  }

  /** Register r (0-7 = B C D E H L - A), with H and L meaning the halves of IX or IY after a prefix. */
  private getR(r: number): number {
    if (this.index !== Index.HL && (r === 4 || r === 5)) {
      const pair = this.index === Index.IX ? this.ix : this.iy;
      return r === 4 ? pair >> 8 : pair & 0xff;
    }
    return this.getRPlain(r);
  }
  private setR(r: number, value: number): void {
    if (this.index !== Index.HL && (r === 4 || r === 5)) {
      const pair = this.index === Index.IX ? this.ix : this.iy;
      const updated = r === 4 ? (pair & 0x00ff) | (value << 8) : (pair & 0xff00) | value;
      if (this.index === Index.IX) this.ix = updated;
      else this.iy = updated;
      return;
    }
    this.setRPlain(r, value);
  }

  /** Register r, ignoring any prefix (as in LD H,(IX+d)). */
  private getRPlain(r: number): number {
    switch (r) {
      case 0:
        return this.b;
      case 1:
        return this.c;
      case 2:
        return this.d;
      case 3:
        return this.e;
      case 4:
        return this.h;
      case 5:
        return this.l;
      default:
        return this.a;
    }
  }
  private setRPlain(r: number, value: number): void {
    switch (r) {
      case 0:
        this.b = value;
        break;
      case 1:
        this.c = value;
        break;
      case 2:
        this.d = value;
        break;
      case 3:
        this.e = value;
        break;
      case 4:
        this.h = value;
        break;
      case 5:
        this.l = value;
        break;
      default:
        this.a = value;
    }
  }

  // --- Memory -----------------------------------------------------------------------

  private fetch(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  /** An M1 cycle: fetches an opcode byte and refreshes R. */
  private fetchOpcode(): number {
    this.incrementR();
    return this.fetch();
  }

  private incrementR(): void {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
  }

  private read16(address: number): number {
    return this.bus.read(address) | (this.bus.read((address + 1) & 0xffff) << 8);
  }

  private write16(address: number, value: number): void {
    this.bus.write(address, value & 0xff);
    this.bus.write((address + 1) & 0xffff, (value >> 8) & 0xff);
  }

  private push(value: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, (value >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, value & 0xff);
  }

  private pop(): number {
    const value = this.read16(this.sp);
    this.sp = (this.sp + 2) & 0xffff;
    return value;
  }

  /** The address of the (HL) operand: HL, or IX/IY plus a displacement (8 more T-states). */
  private operandAddress(): number {
    if (this.index === Index.HL) return this.hl;
    const address = (this.xy + signed(this.fetch())) & 0xffff;
    this.memptr = address;
    this.t += 8;
    return address;
  }

  /** Register r, or the byte at (HL)/(IX+d) for r = 6. */
  private readOperand(r: number): number {
    return r === 6 ? this.bus.read(this.operandAddress()) : this.getR(r);
  }

  // --- Interrupts ---------------------------------------------------------------------

  private acceptNmi(): void {
    this.halted = false;
    this.iff1 = false;
    this.incrementR();
    this.push(this.pc);
    this.pc = this.memptr = 0x0066;
    this.t = 11;
  }

  private acceptInterrupt(): void {
    this.halted = false;
    this.iff1 = this.iff2 = false;
    this.incrementR();
    this.push(this.pc);
    if (this.im === 2) {
      this.pc = this.read16((this.i << 8) | this.irqData);
      this.t = 19;
    } else {
      // In IM 0 the device supplies an instruction; in practice always an RST.
      this.pc = this.im === 0 && (this.irqData & 0xc7) === 0xc7 ? this.irqData & 0x38 : 0x0038;
      this.t = 13;
    }
    this.memptr = this.pc;
  }

  // --- Decoding -----------------------------------------------------------------------

  private executeNext(): void {
    let op = this.fetchOpcode();
    this.index = Index.HL;
    // DD and FD only modify the next opcode; a run of them acts as NOPs until the last one.
    while (op === 0xdd || op === 0xfd) {
      this.index = op === 0xdd ? Index.IX : Index.IY;
      this.t += 4;
      op = this.fetchOpcode();
    }
    if (op === 0xed) {
      this.index = Index.HL;
      this.executeED(this.fetchOpcode());
    } else if (op === 0xcb) {
      if (this.index === Index.HL) this.executeCB(this.fetchOpcode());
      else this.executeIndexedCB();
    } else {
      this.execute(op);
    }
  }

  private condition(cc: number): boolean {
    switch (cc) {
      case 0:
        return (this.f & FLAG_Z) === 0;
      case 1:
        return (this.f & FLAG_Z) !== 0;
      case 2:
        return (this.f & FLAG_C) === 0;
      case 3:
        return (this.f & FLAG_C) !== 0;
      case 4:
        return (this.f & FLAG_PV) === 0;
      case 5:
        return (this.f & FLAG_PV) !== 0;
      case 6:
        return (this.f & FLAG_S) === 0;
      default:
        return (this.f & FLAG_S) !== 0;
    }
  }

  private execute(op: number): void {
    const y = (op >> 3) & 7;
    const z = op & 7;
    switch (op >> 6) {
      case 0:
        this.executeQuarter0(op, y, z);
        return;
      case 1:
        if (op === 0x76) {
          this.halted = true;
          this.t += 4;
        } else if (z === 6) {
          this.setRPlain(y, this.bus.read(this.operandAddress()));
          this.t += 7;
        } else if (y === 6) {
          this.bus.write(this.operandAddress(), this.getRPlain(z));
          this.t += 7;
        } else {
          this.setR(y, this.getR(z));
          this.t += 4;
        }
        return;
      case 2:
        this.alu(y, this.readOperand(z));
        this.t += z === 6 ? 7 : 4;
        return;
      default:
        this.executeQuarter3(y, z);
    }
  }

  private executeQuarter0(op: number, y: number, z: number): void {
    const p = y >> 1;
    const q = y & 1;
    switch (z) {
      case 0:
        switch (y) {
          case 0: // NOP
            this.t += 4;
            return;
          case 1: {
            // EX AF,AF'
            const { a, f } = this;
            this.a = this.a2;
            this.f = this.f2;
            this.a2 = a;
            this.f2 = f;
            this.t += 4;
            return;
          }
          case 2: {
            // DJNZ e
            const offset = signed(this.fetch());
            this.b = (this.b - 1) & 0xff;
            this.t += 8;
            if (this.b !== 0) this.jumpRelative(offset);
            return;
          }
          case 3: // JR e
            this.t += 7;
            this.jumpRelative(signed(this.fetch()));
            return;
          default: {
            // JR cc,e
            const offset = signed(this.fetch());
            this.t += 7;
            if (this.condition(y - 4)) this.jumpRelative(offset);
            return;
          }
        }
      case 1:
        if (q === 0) {
          this.setRp(p, this.fetch16());
          this.t += 10;
        } else {
          this.xy = this.add16(this.xy, this.getRp(p));
          this.t += 11;
        }
        return;
      case 2:
        this.executeIndirectLoad(p, q);
        return;
      case 3:
        this.setRp(p, this.getRp(p) + (q === 0 ? 1 : -1));
        this.t += 6;
        return;
      case 4:
      case 5: {
        const step = z === 4 ? this.inc8 : this.dec8;
        if (y === 6) {
          const address = this.operandAddress();
          this.bus.write(address, step.call(this, this.bus.read(address)));
          this.t += 11;
        } else {
          this.setR(y, step.call(this, this.getR(y)));
          this.t += 4;
        }
        return;
      }
      case 6:
        if (y === 6) {
          const address = this.operandAddress();
          // The displacement and the value overlap: LD (IX+d),n is 19 T-states, not 23.
          if (this.index !== Index.HL) this.t -= 3;
          this.bus.write(address, this.fetch());
          this.t += 10;
        } else {
          this.setR(y, this.fetch());
          this.t += 7;
        }
        return;
      default:
        this.executeAccumulatorOp(op);
        this.t += 4;
    }
  }

  private jumpRelative(offset: number): void {
    this.pc = this.memptr = (this.pc + offset) & 0xffff;
    this.t += 5;
  }

  /** LD (BC)/(DE)/(nn),A and HL, and the loads back. */
  private executeIndirectLoad(p: number, q: number): void {
    if (p === 2) {
      const address = this.fetch16();
      if (q === 0) this.write16(address, this.xy);
      else this.xy = this.read16(address);
      this.memptr = (address + 1) & 0xffff;
      this.t += 16;
      return;
    }
    const address = p === 0 ? this.bc : p === 1 ? this.de : this.fetch16();
    if (q === 0) {
      this.bus.write(address, this.a);
      this.memptr = ((address + 1) & 0xff) | (this.a << 8);
    } else {
      this.a = this.bus.read(address);
      this.memptr = (address + 1) & 0xffff;
    }
    this.t += p === 3 ? 13 : 7;
  }

  /** RLCA, RRCA, RLA, RRA, DAA, CPL, SCF and CCF. */
  private executeAccumulatorOp(op: number): void {
    const keep = this.f & FLAGS_SZPV;
    switch (op) {
      case 0x07: {
        this.a = ((this.a << 1) | (this.a >> 7)) & 0xff;
        this.f = keep | (this.a & (FLAGS_XY | FLAG_C));
        return;
      }
      case 0x0f: {
        const carry = this.a & 1;
        this.a = (this.a >> 1) | (carry << 7);
        this.f = keep | (this.a & FLAGS_XY) | carry;
        return;
      }
      case 0x17: {
        const carry = this.a >> 7;
        this.a = ((this.a << 1) | (this.f & FLAG_C)) & 0xff;
        this.f = keep | (this.a & FLAGS_XY) | carry;
        return;
      }
      case 0x1f: {
        const carry = this.a & 1;
        this.a = (this.a >> 1) | ((this.f & FLAG_C) << 7);
        this.f = keep | (this.a & FLAGS_XY) | carry;
        return;
      }
      case 0x27:
        this.daa();
        return;
      case 0x2f:
        this.a ^= 0xff;
        this.f = (this.f & (FLAGS_SZPV | FLAG_C)) | FLAG_H | FLAG_N | (this.a & FLAGS_XY);
        return;
      case 0x37:
        this.f = keep | FLAG_C | (this.a & FLAGS_XY);
        return;
      default:
        this.f = keep | (this.f & FLAG_C ? FLAG_H : FLAG_C) | (this.a & FLAGS_XY);
    }
  }

  private executeQuarter3(y: number, z: number): void {
    const p = y >> 1;
    const q = y & 1;
    switch (z) {
      case 0: // RET cc
        this.t += 5;
        if (this.condition(y)) {
          this.pc = this.memptr = this.pop();
          this.t += 6;
        }
        return;
      case 1:
        if (q === 0) {
          const value = this.pop();
          if (p === 3) this.af = value;
          else this.setRp(p, value);
          this.t += 10;
          return;
        }
        switch (p) {
          case 0: // RET
            this.pc = this.memptr = this.pop();
            this.t += 10;
            return;
          case 1:
            this.exx();
            this.t += 4;
            return;
          case 2: // JP (HL)
            this.pc = this.xy;
            this.t += 4;
            return;
          default: // LD SP,HL
            this.sp = this.xy;
            this.t += 6;
            return;
        }
      case 2: {
        // JP cc,nn
        const address = this.fetch16();
        this.memptr = address;
        if (this.condition(y)) this.pc = address;
        this.t += 10;
        return;
      }
      case 3:
        this.executeMisc(y);
        return;
      case 4: {
        // CALL cc,nn
        const address = this.fetch16();
        this.memptr = address;
        this.t += 10;
        if (this.condition(y)) {
          this.push(this.pc);
          this.pc = address;
          this.t += 7;
        }
        return;
      }
      case 5:
        if (q === 0) {
          this.push(p === 3 ? this.af : this.getRp(p));
          this.t += 11;
        } else {
          // CALL nn (the DD, ED and FD prefixes are handled before decoding)
          const address = this.fetch16();
          this.push(this.pc);
          this.pc = this.memptr = address;
          this.t += 17;
        }
        return;
      case 6:
        this.alu(y, this.fetch());
        this.t += 7;
        return;
      default: // RST
        this.push(this.pc);
        this.pc = this.memptr = y << 3;
        this.t += 11;
    }
  }

  private executeMisc(y: number): void {
    switch (y) {
      case 0: // JP nn
        this.pc = this.memptr = this.fetch16();
        this.t += 10;
        return;
      case 2: {
        // OUT (n),A
        const port = this.fetch();
        this.bus.output((this.a << 8) | port, this.a);
        this.memptr = ((port + 1) & 0xff) | (this.a << 8);
        this.t += 11;
        return;
      }
      case 3: {
        // IN A,(n)
        const port = (this.a << 8) | this.fetch();
        this.a = this.bus.input(port);
        this.memptr = (port + 1) & 0xffff;
        this.t += 11;
        return;
      }
      case 4: {
        // EX (SP),HL
        const value = this.read16(this.sp);
        this.write16(this.sp, this.xy);
        this.xy = this.memptr = value;
        this.t += 19;
        return;
      }
      case 5: {
        // EX DE,HL (never IX/IY)
        const { d, e } = this;
        this.d = this.h;
        this.e = this.l;
        this.h = d;
        this.l = e;
        this.t += 4;
        return;
      }
      case 6: // DI
        this.iff1 = this.iff2 = false;
        this.t += 4;
        return;
      default: // EI
        this.iff1 = this.iff2 = true;
        this.eiDelay = true;
        this.t += 4;
    }
  }

  private exx(): void {
    let swap = this.b;
    this.b = this.b2;
    this.b2 = swap;
    swap = this.c;
    this.c = this.c2;
    this.c2 = swap;
    swap = this.d;
    this.d = this.d2;
    this.d2 = swap;
    swap = this.e;
    this.e = this.e2;
    this.e2 = swap;
    swap = this.h;
    this.h = this.h2;
    this.h2 = swap;
    swap = this.l;
    this.l = this.l2;
    this.l2 = swap;
  }

  // --- CB prefix ----------------------------------------------------------------------

  private executeCB(op: number): void {
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const value = z === 6 ? this.bus.read(this.hl) : this.getRPlain(z);
    if (x === 1) {
      this.bit(y, value, z === 6 ? this.memptr >> 8 : value);
      this.t += z === 6 ? 12 : 8;
      return;
    }
    const result = this.bitOp(x, y, value);
    if (z === 6) this.bus.write(this.hl, result);
    else this.setRPlain(z, result);
    this.t += z === 6 ? 15 : 8;
  }

  /** DD CB d op / FD CB d op: the operation on (IX+d), also copied to a register unless op names (HL). */
  private executeIndexedCB(): void {
    const address = (this.xy + signed(this.fetch())) & 0xffff;
    const op = this.fetch();
    this.memptr = address;
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const value = this.bus.read(address);
    if (x === 1) {
      this.bit(y, value, address >> 8);
      this.t += 16;
      return;
    }
    const result = this.bitOp(x, y, value);
    this.bus.write(address, result);
    if (z !== 6) this.setRPlain(z, result);
    this.t += 19;
  }

  /** A rotate or shift (x = 0), RES (x = 2) or SET (x = 3). */
  private bitOp(x: number, y: number, value: number): number {
    if (x === 2) return value & ~(1 << y);
    if (x === 3) return value | (1 << y);
    let result: number;
    let carry: number;
    switch (y) {
      case 0: // RLC
        carry = value >> 7;
        result = ((value << 1) | carry) & 0xff;
        break;
      case 1: // RRC
        carry = value & 1;
        result = (value >> 1) | (carry << 7);
        break;
      case 2: // RL
        carry = value >> 7;
        result = ((value << 1) | (this.f & FLAG_C)) & 0xff;
        break;
      case 3: // RR
        carry = value & 1;
        result = (value >> 1) | ((this.f & FLAG_C) << 7);
        break;
      case 4: // SLA
        carry = value >> 7;
        result = (value << 1) & 0xff;
        break;
      case 5: // SRA
        carry = value & 1;
        result = (value >> 1) | (value & 0x80);
        break;
      case 6: // SLL (undocumented: shifts a 1 in)
        carry = value >> 7;
        result = ((value << 1) | 1) & 0xff;
        break;
      default: // SRL
        carry = value & 1;
        result = value >> 1;
    }
    this.f = SZ53P[result] | carry;
    return result;
  }

  /** BIT n: bits 5 and 3 come from `xySource` (the value, or MEMPTR's high byte for memory operands). */
  private bit(n: number, value: number, xySource: number): void {
    const set = value & (1 << n);
    this.f = (this.f & FLAG_C) | FLAG_H | (xySource & FLAGS_XY) | (set ? (n === 7 ? FLAG_S : 0) : FLAG_Z | FLAG_PV);
  }

  // --- ED prefix ----------------------------------------------------------------------

  private executeED(op: number): void {
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    if (x === 2 && y >= 4 && z <= 3) {
      this.blockOp(y, z);
      return;
    }
    if (x !== 1) {
      this.t += 8; // An empty slot: acts as two NOPs.
      return;
    }
    const p = y >> 1;
    const q = y & 1;
    switch (z) {
      case 0: {
        // IN r,(C); ED 70 only sets the flags
        const value = this.bus.input(this.bc);
        this.memptr = (this.bc + 1) & 0xffff;
        if (y !== 6) this.setRPlain(y, value);
        this.f = (this.f & FLAG_C) | SZ53P[value];
        this.t += 12;
        return;
      }
      case 1:
        // OUT (C),r; ED 71 puts out 0
        this.bus.output(this.bc, y === 6 ? 0 : this.getRPlain(y));
        this.memptr = (this.bc + 1) & 0xffff;
        this.t += 12;
        return;
      case 2:
        this.memptr = (this.hl + 1) & 0xffff;
        this.hl = q === 0 ? this.sbc16(this.hl, this.getRp(p)) : this.adc16(this.hl, this.getRp(p));
        this.t += 15;
        return;
      case 3: {
        const address = this.fetch16();
        if (q === 0) this.write16(address, this.getRp(p));
        else this.setRp(p, this.read16(address));
        this.memptr = (address + 1) & 0xffff;
        this.t += 20;
        return;
      }
      case 4: {
        // NEG
        const value = this.a;
        this.a = 0;
        this.alu(2, value);
        this.t += 8;
        return;
      }
      case 5: // RETN, RETI
        this.pc = this.memptr = this.pop();
        this.iff1 = this.iff2;
        this.t += 14;
        return;
      case 6:
        this.im = IM_MODES[y];
        this.t += 8;
        return;
      default:
        this.executeEDMisc(y);
    }
  }

  private executeEDMisc(y: number): void {
    switch (y) {
      case 0: // LD I,A
        this.i = this.a;
        this.t += 9;
        return;
      case 1: // LD R,A
        this.r = this.a;
        this.t += 9;
        return;
      case 2: // LD A,I
      case 3: // LD A,R
        this.a = y === 2 ? this.i : this.r;
        this.f = (this.f & FLAG_C) | SZ53[this.a] | (this.iff2 ? FLAG_PV : 0);
        this.t += 9;
        return;
      case 4: {
        // RRD
        const value = this.bus.read(this.hl);
        this.bus.write(this.hl, ((this.a << 4) | (value >> 4)) & 0xff);
        this.a = (this.a & 0xf0) | (value & 0x0f);
        this.f = (this.f & FLAG_C) | SZ53P[this.a];
        this.memptr = (this.hl + 1) & 0xffff;
        this.t += 18;
        return;
      }
      case 5: {
        // RLD
        const value = this.bus.read(this.hl);
        this.bus.write(this.hl, ((value << 4) | (this.a & 0x0f)) & 0xff);
        this.a = (this.a & 0xf0) | (value >> 4);
        this.f = (this.f & FLAG_C) | SZ53P[this.a];
        this.memptr = (this.hl + 1) & 0xffff;
        this.t += 18;
        return;
      }
      default:
        this.t += 8;
    }
  }

  /** LDI/LDD/CPI/CPD/INI/IND/OUTI/OUTD (y = 4, 5) and their repeating forms (y = 6, 7). */
  private blockOp(y: number, z: number): void {
    const step = y & 1 ? -1 : 1;
    const repeats = y >= 6;
    let again = false;
    switch (z) {
      case 0: {
        const value = this.bus.read(this.hl);
        this.bus.write(this.de, value);
        this.hl = this.hl + step;
        this.de = this.de + step;
        this.bc = this.bc - 1;
        const n = (value + this.a) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_C)) | (this.bc !== 0 ? FLAG_PV : 0) | (n & FLAG_X) | ((n & 0x02) << 4);
        again = this.bc !== 0;
        break;
      }
      case 1: {
        const value = this.bus.read(this.hl);
        const result = (this.a - value) & 0xff;
        const halfCarry = (this.a ^ value ^ result) & FLAG_H;
        const n = result - (halfCarry ? 1 : 0);
        this.hl = this.hl + step;
        this.bc = this.bc - 1;
        this.memptr = (this.memptr + step) & 0xffff;
        this.f =
          (this.f & FLAG_C) |
          FLAG_N |
          (SZ53[result] & ~FLAGS_XY) |
          halfCarry |
          (this.bc !== 0 ? FLAG_PV : 0) |
          (n & FLAG_X) |
          ((n & 0x02) << 4);
        again = this.bc !== 0 && result !== 0;
        break;
      }
      case 2: {
        const value = this.bus.input(this.bc);
        this.memptr = (this.bc + step) & 0xffff;
        this.bus.write(this.hl, value);
        this.b = (this.b - 1) & 0xff;
        this.hl = this.hl + step;
        this.blockIoFlags(value, value + ((this.c + step) & 0xff));
        again = this.b !== 0;
        break;
      }
      default: {
        const value = this.bus.read(this.hl);
        this.b = (this.b - 1) & 0xff;
        this.bus.output(this.bc, value);
        this.memptr = (this.bc + step) & 0xffff;
        this.hl = this.hl + step;
        this.blockIoFlags(value, value + this.l);
        again = this.b !== 0;
      }
    }
    if (repeats && again) {
      this.pc = (this.pc - 2) & 0xffff;
      this.memptr = (this.pc + 1) & 0xffff;
      this.t += 21;
    } else {
      this.t += 16;
    }
  }

  private blockIoFlags(value: number, k: number): void {
    this.f = SZ53[this.b] | ((value & 0x80) >> 6) | (k > 0xff ? FLAG_H | FLAG_C : 0) | (SZ53P[(k & 7) ^ this.b] & FLAG_PV);
  }

  // --- Arithmetic ---------------------------------------------------------------------

  /** ADD, ADC, SUB, SBC, AND, XOR, OR or CP (y = 0-7) with A. */
  private alu(y: number, value: number): void {
    const a = this.a;
    switch (y) {
      case 0:
      case 1: {
        const result = a + value + (y === 1 ? this.f & FLAG_C : 0);
        this.a = result & 0xff;
        this.f = SZ53[this.a] | ((result >> 8) & FLAG_C) | ((a ^ value ^ result) & FLAG_H) | (((a ^ result) & (value ^ result) & 0x80) >> 5);
        return;
      }
      case 2:
      case 3:
      case 7: {
        const result = a - value - (y === 3 ? this.f & FLAG_C : 0);
        const flags = FLAG_N | ((result >> 8) & FLAG_C) | ((a ^ value ^ result) & FLAG_H) | (((a ^ value) & (a ^ result) & 0x80) >> 5);
        if (y === 7) {
          // CP takes bits 5 and 3 from the operand, not the result.
          this.f = flags | (SZ53[result & 0xff] & ~FLAGS_XY) | (value & FLAGS_XY);
        } else {
          this.a = result & 0xff;
          this.f = flags | SZ53[this.a];
        }
        return;
      }
      case 4:
        this.a = a & value;
        this.f = SZ53P[this.a] | FLAG_H;
        return;
      case 5:
        this.a = a ^ value;
        this.f = SZ53P[this.a];
        return;
      default:
        this.a = a | value;
        this.f = SZ53P[this.a];
    }
  }

  private inc8(value: number): number {
    const result = (value + 1) & 0xff;
    this.f = (this.f & FLAG_C) | SZ53[result] | (value === 0x7f ? FLAG_PV : 0) | ((value & 0x0f) === 0x0f ? FLAG_H : 0);
    return result;
  }

  private dec8(value: number): number {
    const result = (value - 1) & 0xff;
    this.f = (this.f & FLAG_C) | FLAG_N | SZ53[result] | (value === 0x80 ? FLAG_PV : 0) | ((value & 0x0f) === 0 ? FLAG_H : 0);
    return result;
  }

  private add16(a: number, b: number): number {
    const result = a + b;
    this.memptr = (a + 1) & 0xffff;
    this.f = (this.f & FLAGS_SZPV) | ((result >> 16) & FLAG_C) | ((result >> 8) & FLAGS_XY) | (((a ^ b ^ result) >> 8) & FLAG_H);
    return result & 0xffff;
  }

  private adc16(a: number, b: number): number {
    const result = a + b + (this.f & FLAG_C);
    this.f =
      ((result >> 16) & FLAG_C) |
      ((result >> 8) & (FLAG_S | FLAGS_XY)) |
      (((a ^ b ^ result) >> 8) & FLAG_H) |
      (((a ^ result) & (b ^ result) & 0x8000) >> 13) |
      ((result & 0xffff) === 0 ? FLAG_Z : 0);
    return result & 0xffff;
  }

  private sbc16(a: number, b: number): number {
    const result = a - b - (this.f & FLAG_C);
    this.f =
      FLAG_N |
      ((result >> 16) & FLAG_C) |
      ((result >> 8) & (FLAG_S | FLAGS_XY)) |
      (((a ^ b ^ result) >> 8) & FLAG_H) |
      (((a ^ b) & (a ^ result) & 0x8000) >> 13) |
      ((result & 0xffff) === 0 ? FLAG_Z : 0);
    return result & 0xffff;
  }

  private daa(): void {
    const a = this.a;
    let correction = 0;
    let carry = this.f & FLAG_C;
    if (this.f & FLAG_H || (a & 0x0f) > 9) correction = 0x06;
    if (carry || a > 0x99) {
      correction |= 0x60;
      carry = FLAG_C;
    }
    let halfCarry: boolean;
    if (this.f & FLAG_N) {
      halfCarry = (this.f & FLAG_H) !== 0 && (a & 0x0f) < 6;
      this.a = (a - correction) & 0xff;
    } else {
      halfCarry = (a & 0x0f) > 9;
      this.a = (a + correction) & 0xff;
    }
    this.f = SZ53P[this.a] | (this.f & FLAG_N) | carry | (halfCarry ? FLAG_H : 0);
  }
}
