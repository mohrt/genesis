/** What the 68000 sees of the machine: a 24-bit address bus of bytes and big-endian words. */
export interface M68kBus {
  read8(address: number): number;
  read16(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  /** The CPU took an interrupt at `level` (devices on the Genesis use autovectors). */
  acknowledgeInterrupt(level: number): void;
  /** The RESET instruction pulses the reset line of the other chips. */
  resetDevices(): void;
}

type Size = 1 | 2 | 4;
type Handler = (this: M68k, op: number) => void;

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const MSB = [0, 0x80, 0x8000, 0, 0x80000000];
/** The size field of most instructions: 00 byte, 01 word, 10 long. */
const SIZE_FIELD: Size[] = [1, 2, 4];

const VECTOR_ADDRESS_ERROR = 3;
const VECTOR_ILLEGAL = 4;
const VECTOR_ZERO_DIVIDE = 5;
const VECTOR_CHK = 6;
const VECTOR_TRAPV = 7;
const VECTOR_PRIVILEGE = 8;
const VECTOR_TRACE = 9;
const VECTOR_LINE_A = 10;
const VECTOR_LINE_F = 11;
const VECTOR_AUTOVECTOR = 24;
const VECTOR_TRAP = 32;

/** Exception processing after an instruction's own time: the internal steps around the stacking and vector fetch. */
const EXCEPTION_INTERNAL = 10;
/** An interrupt takes 44 cycles: 12 stacking, 8 vector fetch, the rest acknowledging and refilling the prefetch. */
const INTERRUPT_INTERNAL = 24;
/** An address error takes 50 cycles. */
const ADDRESS_ERROR_INTERNAL = 22;

const signed8 = (value: number) => ((value & 0xff) ^ 0x80) - 0x80;
const signed16 = (value: number) => ((value & 0xffff) ^ 0x8000) - 0x8000;
const wrap = (value: number, size: Size) => (size === 4 ? value >>> 0 : value & MASK[size]);

/** Thrown (as a singleton) when a word or long access goes to an odd address; `step` turns it into the exception. */
const ADDRESS_ERROR = { addressError: true };

// --- Effective address classes ------------------------------------------------------

const isValidEa = (mode: number, reg: number) => mode < 7 || reg <= 4;
const isDataEa = (mode: number, reg: number) => mode !== 1 && isValidEa(mode, reg);
const isAlterable = (mode: number, reg: number) => mode < 7 || reg <= 1;
const isDataAlterable = (mode: number, reg: number) => mode !== 1 && isAlterable(mode, reg);
const isMemoryAlterable = (mode: number, reg: number) => mode >= 2 && isAlterable(mode, reg);
const isControl = (mode: number, reg: number) => mode === 2 || mode === 5 || mode === 6 || (mode === 7 && reg <= 3);

/**
 * A Motorola 68000, instruction-stepped. Every 68000 instruction, the
 * supervisor and user stacks, the seven interrupt levels with autovectors,
 * trace, address errors and the other exceptions, and the undocumented flag
 * results of the BCD, CHK and divide instructions. Times are counted per
 * instruction: 4 cycles for each bus access plus each instruction's internal
 * time, including the data-dependent multiply and divide times.
 */
export class M68k {
  readonly d = new Uint32Array(8);
  /** A0-A7; A7 is the stack pointer of the current mode. */
  readonly a = new Uint32Array(8);
  /** The stack pointer of the other mode (the user one in supervisor mode, and the other way round). */
  otherSp = 0;
  pc = 0;
  x = false;
  n = false;
  z = false;
  v = false;
  c = false;
  supervisor = true;
  trace = false;
  intMask = 7;
  /** Stopped by STOP until an interrupt. */
  stopped = false;
  /** The interrupt level asserted by the machine (0 for none). */
  irqLevel = 0;
  /** Cycles run since power on. */
  cycles = 0;
  /** Address errors taken since power on (the tests skip those, whose stack frames are not modelled exactly). */
  addressErrors = 0;
  /** The opcode being executed. */
  private ir = 0;
  /** The address of the instruction being executed. */
  private instructionPc = 0;
  /** The address of the last memory operand read, for read-modify-write instructions. */
  private ea = 0;
  /** The address and direction of an access that faulted. */
  private faultAddress = 0;
  private faultRead = true;
  private faultInstruction = false;

  constructor(private readonly bus: M68kBus) {}

  /** The reset sequence: supervisor mode, interrupts masked, the stack pointer and PC from the vector table. */
  reset(): void {
    this.supervisor = true;
    this.trace = false;
    this.intMask = 7;
    this.stopped = false;
    this.a[7] = this.read32(0);
    this.pc = this.read32(4);
    this.cycles += 132 - 16;
  }

  get sr(): number {
    return (
      (this.trace ? 0x8000 : 0) |
      (this.supervisor ? 0x2000 : 0) |
      (this.intMask << 8) |
      (this.x ? 0x10 : 0) |
      (this.n ? 0x08 : 0) |
      (this.z ? 0x04 : 0) |
      (this.v ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  set sr(value: number) {
    this.trace = (value & 0x8000) !== 0;
    this.intMask = (value >> 8) & 7;
    this.ccr = value;
    this.setSupervisor((value & 0x2000) !== 0);
  }

  set ccr(value: number) {
    this.x = (value & 0x10) !== 0;
    this.n = (value & 0x08) !== 0;
    this.z = (value & 0x04) !== 0;
    this.v = (value & 0x02) !== 0;
    this.c = (value & 0x01) !== 0;
  }

  get usp(): number {
    return this.supervisor ? this.otherSp : this.a[7];
  }

  set usp(value: number) {
    if (this.supervisor) this.otherSp = value >>> 0;
    else this.a[7] = value;
  }

  get ssp(): number {
    return this.supervisor ? this.a[7] : this.otherSp;
  }

  set ssp(value: number) {
    if (this.supervisor) this.a[7] = value;
    else this.otherSp = value >>> 0;
  }

  private setSupervisor(on: boolean): void {
    if (on === this.supervisor) return;
    const sp = this.a[7];
    this.a[7] = this.otherSp;
    this.otherSp = sp;
    this.supervisor = on;
  }

  /** Runs one instruction (or takes an interrupt) and returns the cycles it took. */
  step(): number {
    const start = this.cycles;
    const tracing = this.trace;
    try {
      if (this.irqLevel > this.intMask) {
        this.interrupt(this.irqLevel);
        return this.cycles - start;
      }
      if (this.stopped) {
        this.cycles += 4;
        return 4;
      }
      this.instructionPc = this.pc;
      const op = this.fetch16();
      this.ir = op;
      OPCODES[op].call(this, op);
      if (tracing) this.exception(VECTOR_TRACE, this.pc, 0);
    } catch (error) {
      if (error !== ADDRESS_ERROR) throw error;
      this.addressError();
    }
    return this.cycles - start;
  }

  // --- Bus access ---------------------------------------------------------------

  private fault(address: number, read: boolean, instruction: boolean): never {
    this.faultAddress = address;
    this.faultRead = read;
    this.faultInstruction = instruction;
    throw ADDRESS_ERROR;
  }

  private read8(address: number): number {
    this.cycles += 4;
    return this.bus.read8(address & 0xffffff);
  }

  private read16(address: number): number {
    if (address & 1) this.fault(address, true, false);
    this.cycles += 4;
    return this.bus.read16(address & 0xffffff);
  }

  private read32(address: number): number {
    const high = this.read16(address);
    return ((high << 16) | this.read16(address + 2)) >>> 0;
  }

  private write8(address: number, value: number): void {
    this.cycles += 4;
    this.bus.write8(address & 0xffffff, value & 0xff);
  }

  private write16(address: number, value: number): void {
    if (address & 1) this.fault(address, false, false);
    this.cycles += 4;
    this.bus.write16(address & 0xffffff, value & 0xffff);
  }

  private write32(address: number, value: number): void {
    this.write16(address, value >>> 16);
    this.write16(address + 2, value);
  }

  private readSized(address: number, size: Size): number {
    if (size === 1) return this.read8(address);
    if (size === 2) return this.read16(address);
    return this.read32(address);
  }

  private writeSized(address: number, size: Size, value: number): void {
    if (size === 1) this.write8(address, value);
    else if (size === 2) this.write16(address, value);
    else this.write32(address, value);
  }

  /** Jumps, branches and returns refill the prefetch at once, so an odd target faults within the instruction. */
  private jump(address: number): void {
    this.pc = address >>> 0;
    if (address & 1) this.fault(address, true, true);
  }

  private fetch16(): number {
    const pc = this.pc;
    if (pc & 1) this.fault(pc, true, true);
    this.cycles += 4;
    this.pc = (pc + 2) >>> 0;
    return this.bus.read16(pc & 0xffffff);
  }

  private fetch32(): number {
    const high = this.fetch16();
    return ((high << 16) | this.fetch16()) >>> 0;
  }

  private fetchImmediate(size: Size): number {
    if (size === 1) return this.fetch16() & 0xff;
    if (size === 2) return this.fetch16();
    return this.fetch32();
  }

  private push16(value: number): void {
    this.a[7] -= 2;
    this.write16(this.a[7], value);
  }

  private push32(value: number): void {
    this.a[7] -= 4;
    this.write32(this.a[7], value);
  }

  private pop16(): number {
    const value = this.read16(this.a[7]);
    this.a[7] += 2;
    return value;
  }

  private pop32(): number {
    const value = this.read32(this.a[7]);
    this.a[7] += 4;
    return value;
  }

  // --- Effective addresses ----------------------------------------------------------

  /** The step of (An)+ and -(An): the operand size, except that A7 stays word-aligned for bytes. */
  private static step(reg: number, size: Size): number {
    return reg === 7 && size === 1 ? 2 : size;
  }

  /**
   * The address of a memory operand (modes 2-7), fetching its extension words.
   * -(An) takes 2 cycles to decrement, except as a MOVE destination.
   */
  private address(mode: number, reg: number, size: Size, predecrementTime = true): number {
    switch (mode) {
      case 2:
        return this.a[reg];
      case 3: {
        const address = this.a[reg];
        this.a[reg] += M68k.step(reg, size);
        return address;
      }
      case 4:
        if (predecrementTime) this.cycles += 2;
        this.a[reg] -= M68k.step(reg, size);
        return this.a[reg];
      case 5: {
        const base = this.a[reg];
        return (base + signed16(this.fetch16())) >>> 0;
      }
      case 6:
        return this.indexed(this.a[reg]);
      default:
        switch (reg) {
          case 0:
            return signed16(this.fetch16()) >>> 0;
          case 1:
            return this.fetch32();
          case 2: {
            const base = this.pc;
            return (base + signed16(this.fetch16())) >>> 0;
          }
          default:
            return this.indexed(this.pc);
        }
    }
  }

  /** d8(An,Xn) and d8(PC,Xn): the brief extension word gives the index register, its size and the displacement. */
  private indexed(base: number): number {
    const extension = this.fetch16();
    this.cycles += 2;
    const reg = (extension >> 12) & 7;
    let index = extension & 0x8000 ? this.a[reg] : this.d[reg];
    if (!(extension & 0x0800)) index = signed16(index);
    return (base + signed8(extension) + index) >>> 0;
  }

  /** Reads an operand of any addressing mode; memory operands leave their address in `ea` for a write back. */
  private readEa(mode: number, reg: number, size: Size): number {
    if (mode === 0) return wrap(this.d[reg], size);
    if (mode === 1) return wrap(this.a[reg], size);
    if (mode === 7 && reg === 4) return this.fetchImmediate(size);
    this.ea = this.address(mode, reg, size);
    return this.readSized(this.ea, size);
  }

  /** Writes back to the operand last read by `readEa`. */
  private writeBack(mode: number, reg: number, size: Size, value: number): void {
    if (mode === 0) this.setD(reg, size, value);
    else if (mode === 1) this.a[reg] = value;
    else this.writeSized(this.ea, size, value);
  }

  /** Writes an operand that was not read first. */
  private writeEa(mode: number, reg: number, size: Size, value: number, predecrementTime = true): void {
    if (mode === 0) this.setD(reg, size, value);
    else if (mode === 1) this.a[reg] = value;
    else this.writeSized(this.address(mode, reg, size, predecrementTime), size, value);
  }

  private setD(reg: number, size: Size, value: number): void {
    if (size === 4) this.d[reg] = value;
    else if (size === 2) this.d[reg] = (this.d[reg] & 0xffff0000) | (value & 0xffff);
    else this.d[reg] = (this.d[reg] & 0xffffff00) | (value & 0xff);
  }

  // --- Flags and arithmetic -----------------------------------------------------------

  private setNZ(value: number, size: Size): void {
    this.n = (value & MSB[size]) !== 0;
    this.z = (value & MASK[size]) === 0;
  }

  private logic(value: number, size: Size): number {
    this.setNZ(value, size);
    this.v = this.c = false;
    return wrap(value, size);
  }

  private add(source: number, dest: number, size: Size, extend = false): number {
    const raw = source + dest + (extend && this.x ? 1 : 0);
    const result = wrap(raw, size);
    this.x = this.c = raw > MASK[size];
    this.v = (~(source ^ dest) & (source ^ result) & MSB[size]) !== 0;
    this.n = (result & MSB[size]) !== 0;
    if (!extend) this.z = result === 0;
    else if (result !== 0) this.z = false;
    return result;
  }

  /** dest - source. */
  private sub(source: number, dest: number, size: Size, extend = false): number {
    const raw = dest - source - (extend && this.x ? 1 : 0);
    const result = wrap(raw, size);
    this.x = this.c = raw < 0;
    this.v = ((source ^ dest) & (dest ^ result) & MSB[size]) !== 0;
    this.n = (result & MSB[size]) !== 0;
    if (!extend) this.z = result === 0;
    else if (result !== 0) this.z = false;
    return result;
  }

  private compare(source: number, dest: number, size: Size): void {
    const raw = dest - source;
    const result = wrap(raw, size);
    this.c = raw < 0;
    this.v = ((source ^ dest) & (dest ^ result) & MSB[size]) !== 0;
    this.setNZ(result, size);
  }

  private condition(code: number): boolean {
    switch (code) {
      case 0:
        return true;
      case 1:
        return false;
      case 2:
        return !this.c && !this.z;
      case 3:
        return this.c || this.z;
      case 4:
        return !this.c;
      case 5:
        return this.c;
      case 6:
        return !this.z;
      case 7:
        return this.z;
      case 8:
        return !this.v;
      case 9:
        return this.v;
      case 10:
        return !this.n;
      case 11:
        return this.n;
      case 12:
        return this.n === this.v;
      case 13:
        return this.n !== this.v;
      case 14:
        return !this.z && this.n === this.v;
      default:
        return this.z || this.n !== this.v;
    }
  }

  // --- Exceptions -------------------------------------------------------------------

  /** Enters supervisor mode, stacks the PC and SR, and jumps through `vector`. */
  private exception(vector: number, pushedPc: number, internal = EXCEPTION_INTERNAL): void {
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.cycles += internal;
    this.push32(pushedPc);
    this.push16(sr);
    this.jump(this.read32(vector * 4));
  }

  private interrupt(level: number): void {
    this.stopped = false;
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.intMask = level;
    this.cycles += INTERRUPT_INTERNAL;
    this.push32(this.pc);
    this.push16(sr);
    this.bus.acknowledgeInterrupt(level);
    this.jump(this.read32((VECTOR_AUTOVECTOR + level) * 4));
  }

  /** The group 0 frame: the access, the opcode and the SR and PC. A second fault while stacking it would halt a real CPU. */
  private addressError(): void {
    this.addressErrors++;
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.cycles += ADDRESS_ERROR_INTERNAL;
    const functionCode = (this.supervisor ? 4 : 0) | (this.faultInstruction ? 2 : 1);
    const status = (this.faultRead ? 0x10 : 0) | (this.faultInstruction ? 0 : 0x08) | functionCode;
    try {
      this.push32(this.pc);
      this.push16(sr);
      this.push16(this.ir);
      this.push32(this.faultAddress);
      this.push16(status);
      this.pc = this.read32(VECTOR_ADDRESS_ERROR * 4);
    } catch (error) {
      if (error !== ADDRESS_ERROR) throw error;
      this.stopped = true;
    }
  }

  /** Privileged instructions trap in user mode, stacking the instruction's own address. */
  private privileged(): boolean {
    if (this.supervisor) return true;
    this.exception(VECTOR_PRIVILEGE, this.instructionPc);
    return false;
  }

  // --- Instructions -----------------------------------------------------------------

  illegal(): void {
    this.exception(VECTOR_ILLEGAL, this.instructionPc);
  }

  lineA(): void {
    this.exception(VECTOR_LINE_A, this.instructionPc);
  }

  lineF(): void {
    this.exception(VECTOR_LINE_F, this.instructionPc);
  }

  /** ORI, ANDI, SUBI, ADDI, EORI and CMPI. */
  immediate(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const kind = (op >> 9) & 7;
    const source = this.fetchImmediate(size);
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dest = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += kind === 6 ? 2 : 4;
    let result: number;
    switch (kind) {
      case 0:
        result = this.logic(dest | source, size);
        break;
      case 1:
        result = this.logic(dest & source, size);
        break;
      case 2:
        result = this.sub(source, dest, size);
        break;
      case 3:
        result = this.add(source, dest, size);
        break;
      case 5:
        result = this.logic(dest ^ source, size);
        break;
      default:
        this.compare(source, dest, size);
        return;
    }
    this.writeBack(mode, reg, size, result);
  }

  /** ORI, ANDI and EORI to CCR (size 0) or SR (size 1). */
  immediateToStatus(op: number): void {
    const toSr = (op & 0x40) !== 0;
    if (toSr && !this.privileged()) return;
    const value = this.fetch16();
    const current = toSr ? this.sr : this.sr & 0xff;
    const kind = (op >> 9) & 7;
    const result = kind === 0 ? current | value : kind === 1 ? current & value : current ^ value;
    // Internal time, and refilling the prefetch after the status register changes.
    this.cycles += 12;
    if (toSr) this.sr = result;
    else this.ccr = result;
  }

  /** BTST, BCHG, BCLR and BSET, with the bit number in a register (dynamic) or an immediate word (static). */
  bitOp(op: number): void {
    const kind = (op >> 6) & 3;
    const dynamic = (op & 0x100) !== 0;
    const bitNumber = dynamic ? this.d[(op >> 9) & 7] : this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    if (mode === 0) {
      const bit = bitNumber & 31;
      const value = this.d[reg];
      this.z = (value & (1 << bit)) === 0;
      if (kind === 0) {
        this.cycles += 2;
        return;
      }
      this.cycles += kind === 2 ? (bit < 16 ? 4 : 6) : bit < 16 ? 2 : 4;
      if (kind === 1) this.d[reg] = value ^ (1 << bit);
      else if (kind === 2) this.d[reg] = value & ~(1 << bit);
      else this.d[reg] = value | (1 << bit);
      return;
    }
    const bit = bitNumber & 7;
    const value = this.readEa(mode, reg, 1);
    this.z = (value & (1 << bit)) === 0;
    if (kind === 0) {
      if (mode === 7 && reg === 4) this.cycles += 2;
      return;
    }
    const result = kind === 1 ? value ^ (1 << bit) : kind === 2 ? value & ~(1 << bit) : value | (1 << bit);
    this.writeBack(mode, reg, 1, result);
  }

  /** MOVEP: a word or long moved to or from alternate bytes of memory (for 8-bit peripherals). */
  movep(op: number): void {
    const dn = (op >> 9) & 7;
    const address = (this.a[op & 7] + signed16(this.fetch16())) >>> 0;
    const long = (op & 0x40) !== 0;
    const bytes = long ? 4 : 2;
    if (op & 0x80) {
      const value = this.d[dn];
      for (let i = 0; i < bytes; i++) this.write8(address + i * 2, value >>> ((bytes - 1 - i) * 8));
    } else {
      let value = 0;
      for (let i = 0; i < bytes; i++) value = (value << 8) | this.read8(address + i * 2);
      this.setD(dn, long ? 4 : 2, value >>> 0);
    }
  }

  move(op: number): void {
    const size: Size = op >> 12 === 1 ? 1 : op >> 12 === 3 ? 2 : 4;
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    const destMode = (op >> 6) & 7;
    const destReg = (op >> 9) & 7;
    this.setNZ(value, size);
    this.v = this.c = false;
    this.writeEa(destMode, destReg, size, value, false);
  }

  movea(op: number): void {
    const size: Size = op >> 12 === 3 ? 2 : 4;
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    this.a[(op >> 9) & 7] = size === 2 ? signed16(value) : value;
  }

  moveq(op: number): void {
    const value = signed8(op);
    this.d[(op >> 9) & 7] = value;
    this.n = value < 0;
    this.z = value === 0;
    this.v = this.c = false;
  }

  moveFromSr(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    if (mode === 0) {
      this.cycles += 2;
      this.setD(reg, 2, this.sr);
      return;
    }
    // The 68000 reads the destination before writing it.
    this.readEa(mode, reg, 2);
    this.writeSized(this.ea, 2, this.sr);
  }

  moveToCcr(op: number): void {
    const value = this.readEa((op >> 3) & 7, op & 7, 2);
    this.cycles += 8;
    this.ccr = value;
  }

  moveToSr(op: number): void {
    if (!this.privileged()) return;
    const value = this.readEa((op >> 3) & 7, op & 7, 2);
    this.cycles += 8;
    this.sr = value;
  }

  moveUsp(op: number): void {
    if (!this.privileged()) return;
    const reg = op & 7;
    if (op & 0x08) this.a[reg] = this.otherSp;
    else this.otherSp = this.a[reg];
  }

  /** NEGX, CLR, NEG and NOT. */
  unary(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    // Even CLR reads its operand first on the 68000.
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 2;
    let result: number;
    switch ((op >> 9) & 3) {
      case 0:
        result = this.sub(value, 0, size, true);
        break;
      case 1:
        result = 0;
        this.n = this.v = this.c = false;
        this.z = true;
        break;
      case 2:
        result = this.sub(value, 0, size);
        break;
      default:
        result = this.logic(~value, size);
        break;
    }
    this.writeBack(mode, reg, size, result);
  }

  tst(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    this.logic(this.readEa((op >> 3) & 7, op & 7, size), size);
  }

  tas(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 1);
    this.logic(value, 1);
    if (mode !== 0) this.cycles += 2;
    this.writeBack(mode, reg, 1, value | 0x80);
  }

  nbcd(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 1);
    if (mode === 0) this.cycles += 2;
    this.writeBack(mode, reg, 1, this.bcdSubtract(value, 0));
  }

  swap(op: number): void {
    const reg = op & 7;
    const value = this.d[reg];
    this.d[reg] = ((value << 16) | (value >>> 16)) >>> 0;
    this.logic(this.d[reg], 4);
  }

  ext(op: number): void {
    const reg = op & 7;
    if (op & 0x40) {
      this.d[reg] = signed16(this.d[reg]);
      this.logic(this.d[reg], 4);
    } else {
      this.setD(reg, 2, signed8(this.d[reg]));
      this.logic(this.d[reg], 2);
    }
  }

  lea(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    if (mode === 6 || (mode === 7 && reg === 3)) this.cycles += 2;
    this.a[(op >> 9) & 7] = address;
  }

  pea(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    if (mode === 6 || (mode === 7 && reg === 3)) this.cycles += 2;
    this.push32(address);
  }

  /** The extra time JMP and JSR take for each addressing mode, beyond working out the address. */
  private jumpTime(mode: number, reg: number): number {
    if (mode === 2 || mode === 6 || (mode === 7 && reg === 3)) return 4;
    if (mode === 7 && reg === 1) return 0;
    return 2;
  }

  jmp(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    this.cycles += this.jumpTime(mode, reg);
    this.jump(address);
  }

  jsr(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    this.cycles += this.jumpTime(mode, reg);
    this.push32(this.pc);
    this.jump(address);
  }

  /** MOVEM: registers to memory (bit 10 clear) or memory to registers. The mask word lists D0-D7 then A0-A7. */
  movem(op: number): void {
    const size: Size = op & 0x40 ? 4 : 2;
    const mask = this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const step = size;
    if (op & 0x400) {
      let address = mode === 3 ? this.a[reg] : this.address(mode, reg, size);
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const value = this.readSized(address, size);
        const extended = size === 2 ? signed16(value) : value;
        if (i < 8) this.d[i] = extended;
        else this.a[i - 8] = extended;
        address += step;
      }
      // The 68000 reads one word past the last register.
      this.read16(address);
      if (mode === 3) this.a[reg] = address;
      return;
    }
    if (mode === 4) {
      // Predecrement goes from A7 down to D0; the mask is reversed. A stored An is its value before the instruction.
      const original = this.a[reg];
      let address = original;
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const r = 15 - i;
        address = (address - step) >>> 0;
        const value = r < 8 ? this.d[r] : r - 8 === reg ? original : this.a[r - 8];
        this.writeSized(address, size, value);
      }
      this.a[reg] = address;
      return;
    }
    let address = this.address(mode, reg, size);
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      this.writeSized(address, size, i < 8 ? this.d[i] : this.a[i - 8]);
      address += step;
    }
  }

  chk(op: number): void {
    const bound = signed16(this.readEa((op >> 3) & 7, op & 7, 2));
    const value = signed16(this.d[(op >> 9) & 7]);
    this.cycles += 6;
    this.z = value === 0;
    this.v = this.c = false;
    // The upper bound is checked first, and that trap is 2 cycles quicker.
    if (value > bound) {
      this.n = value < 0;
      this.exception(VECTOR_CHK, this.pc, EXCEPTION_INTERNAL - 2);
    } else if (value < 0) {
      this.n = true;
      this.exception(VECTOR_CHK, this.pc);
    }
  }

  trap(op: number): void {
    this.exception(VECTOR_TRAP + (op & 15), this.pc);
  }

  trapv(): void {
    if (this.v) this.exception(VECTOR_TRAPV, this.pc);
  }

  link(op: number): void {
    const reg = op & 7;
    // LINK A7 stacks A7 as it is after the push.
    this.push32(reg === 7 ? this.a[7] - 4 : this.a[reg]);
    this.a[reg] = this.a[7];
    this.a[7] += signed16(this.fetch16());
  }

  unlk(op: number): void {
    const reg = op & 7;
    this.a[7] = this.a[reg];
    this.a[reg] = this.pop32();
  }

  resetInstruction(): void {
    if (!this.privileged()) return;
    this.bus.resetDevices();
    this.cycles += 128;
  }

  nop(): void {}

  stop(): void {
    if (!this.privileged()) return;
    this.sr = this.fetch16();
    this.stopped = true;
  }

  rte(): void {
    if (!this.privileged()) return;
    const sr = this.pop16();
    const pc = this.pop32();
    this.cycles += 4;
    this.sr = sr;
    this.jump(pc);
  }

  rts(): void {
    const pc = this.pop32();
    this.cycles += 4;
    this.jump(pc);
  }

  rtr(): void {
    this.ccr = this.pop16();
    const pc = this.pop32();
    this.cycles += 4;
    this.jump(pc);
  }

  /** ADDQ and SUBQ: 1-8 added to or taken from an operand. On an address register the whole register changes and no flags do. */
  quick(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const amount = ((op >> 9) & 7) || 8;
    const subtract = (op & 0x100) !== 0;
    if (mode === 1) {
      this.cycles += size === 4 ? 2 : 4;
      this.a[reg] = subtract ? this.a[reg] - amount : this.a[reg] + amount;
      return;
    }
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 4;
    this.writeBack(mode, reg, size, subtract ? this.sub(amount, value, size) : this.add(amount, value, size));
  }

  scc(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const set = this.condition((op >> 8) & 15);
    if (mode === 0) {
      if (set) this.cycles += 2;
      this.setD(reg, 1, set ? 0xff : 0);
      return;
    }
    this.readEa(mode, reg, 1);
    this.writeSized(this.ea, 1, set ? 0xff : 0);
  }

  dbcc(op: number): void {
    const base = this.pc;
    const displacement = signed16(this.fetch16());
    if (this.condition((op >> 8) & 15)) {
      this.cycles += 4;
      return;
    }
    const reg = op & 7;
    const count = (this.d[reg] - 1) & 0xffff;
    this.setD(reg, 2, count);
    if (count === 0xffff) {
      this.cycles += 6;
      return;
    }
    this.cycles += 2;
    this.jump(base + displacement);
  }

  /** BRA, BSR and Bcc, with an 8-bit displacement or, when that is 0, a 16-bit one. */
  branch(op: number): void {
    const base = this.pc;
    const condition = (op >> 8) & 15;
    let displacement = signed8(op);
    const long = displacement === 0;
    if (long) displacement = signed16(this.fetch16());
    if (condition === 1) {
      this.cycles += long ? 2 : 6;
      this.push32(this.pc);
      this.jump(base + displacement);
      return;
    }
    if (this.condition(condition)) {
      this.cycles += long ? 2 : 6;
      this.jump(base + displacement);
    } else {
      this.cycles += 4;
    }
  }

  /** OR, AND, ADD and SUB, in both directions: <ea> to Dn (bit 8 clear) or Dn to <ea>. */
  arithmetic(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const line = op >> 12;
    const toEa = (op & 0x100) !== 0;
    const ea = this.readEa(mode, reg, size);
    const register = wrap(this.d[dn], size);
    const [source, dest] = toEa ? [register, ea] : [ea, register];
    let result: number;
    switch (line) {
      case 0x8:
        result = this.logic(source | dest, size);
        break;
      case 0xc:
        result = this.logic(source & dest, size);
        break;
      case 0xd:
        result = this.add(source, dest, size);
        break;
      default:
        result = this.sub(source, dest, size);
        break;
    }
    if (toEa) {
      this.writeBack(mode, reg, size, result);
      return;
    }
    if (size === 4) this.cycles += mode === 0 || mode === 1 || (mode === 7 && reg === 4) ? 4 : 2;
    this.setD(dn, size, result);
  }

  eor(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 4;
    this.writeBack(mode, reg, size, this.logic(value ^ this.d[(op >> 9) & 7], size));
  }

  cmp(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    if (size === 4) this.cycles += 2;
    this.compare(value, wrap(this.d[(op >> 9) & 7], size), size);
  }

  /** ADDA, SUBA and CMPA: a word source is sign-extended, and the whole address register takes part. */
  addressArithmetic(op: number): void {
    const size: Size = op & 0x100 ? 4 : 2;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const raw = this.readEa(mode, reg, size);
    const source = size === 2 ? signed16(raw) >>> 0 : raw;
    const an = (op >> 9) & 7;
    const line = op >> 12;
    if (line === 0xb) {
      this.cycles += 2;
      this.compare(source, this.a[an], 4);
      return;
    }
    this.cycles += size === 2 || mode === 0 || mode === 1 || (mode === 7 && reg === 4) ? 4 : 2;
    this.a[an] = line === 0xd ? this.a[an] + source : this.a[an] - source;
  }

  cmpm(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const source = this.readSized(this.address(3, op & 7, size), size);
    const dest = this.readSized(this.address(3, (op >> 9) & 7, size), size);
    this.compare(source, dest, size);
  }

  /** ADDX, SUBX, ABCD and SBCD: registers (bit 3 clear) or -(Ay),-(Ax). */
  extended(op: number): void {
    const line = op >> 12;
    const bcd = line === 0x8 || line === 0xc;
    const size = bcd ? 1 : SIZE_FIELD[(op >> 6) & 3];
    const rx = (op >> 9) & 7;
    const ry = op & 7;
    let source: number;
    let dest: number;
    const memory = (op & 0x08) !== 0;
    if (memory) {
      source = this.readSized(this.address(4, ry, size), size);
      this.a[rx] -= M68k.step(rx, size);
      this.ea = this.a[rx];
      dest = this.readSized(this.ea, size);
    } else {
      source = wrap(this.d[ry], size);
      dest = wrap(this.d[rx], size);
      if (size === 4) this.cycles += 4;
      else if (bcd) this.cycles += 2;
    }
    let result: number;
    if (line === 0xc) result = this.bcdAdd(source, dest);
    else if (line === 0x8) result = this.bcdSubtract(source, dest);
    else if (line === 0xd) result = this.add(source, dest, size, true);
    else result = this.sub(source, dest, size, true);
    if (memory) this.writeSized(this.ea, size, result);
    else this.setD(rx, size, result);
  }

  /** ABCD's sum, with the 68000's undocumented N and V results. */
  private bcdAdd(source: number, dest: number): number {
    let result = (source & 0x0f) + (dest & 0x0f) + (this.x ? 1 : 0);
    const correction = result > 9 ? 6 : 0;
    result += (source & 0xf0) + (dest & 0xf0);
    const before = result;
    result += correction;
    this.x = this.c = result > 0x9f;
    if (this.c) result -= 0xa0;
    this.v = (~before & result & 0x80) !== 0;
    this.n = (result & 0x80) !== 0;
    result &= 0xff;
    if (result !== 0) this.z = false;
    return result;
  }

  /** dest - source in BCD (SBCD, and NBCD with dest 0), with the undocumented N and V results. */
  private bcdSubtract(source: number, dest: number): number {
    let result = (dest & 0x0f) - (source & 0x0f) - (this.x ? 1 : 0);
    const correction = result > 0x0f || result < 0 ? 6 : 0;
    result += (dest & 0xf0) - (source & 0xf0);
    const before = result;
    if (result > 0xff || result < 0) {
      result += 0xa0;
      this.x = this.c = true;
    } else {
      this.x = this.c = result < correction;
    }
    result = (result - correction) & 0xff;
    this.v = (before & ~result & 0x80) !== 0;
    this.n = (result & 0x80) !== 0;
    if (result !== 0) this.z = false;
    return result;
  }

  mulu(op: number): void {
    const source = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const result = ((this.d[dn] & 0xffff) * source) >>> 0;
    let ones = 0;
    for (let bits = source; bits; bits &= bits - 1) ones++;
    this.cycles += 34 + 2 * ones;
    this.d[dn] = result;
    this.logic(result, 4);
  }

  muls(op: number): void {
    const source = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const result = Math.imul(signed16(this.d[dn]), signed16(source));
    // One step for each change between adjacent bits of the source (with a 0 below bit 0).
    let changes = 0;
    for (let bits = ((source << 1) ^ source) & 0xffff; bits; bits &= bits - 1) changes++;
    this.cycles += 34 + 2 * changes;
    this.d[dn] = result;
    this.logic(result, 4);
  }

  divu(op: number): void {
    const divisor = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const dividend = this.d[dn];
    if (divisor === 0) {
      this.zeroDivide();
      return;
    }
    const quotient = Math.floor(dividend / divisor);
    this.cycles += divuTime(dividend, divisor) - 4;
    this.c = false;
    // On overflow the register is left alone, and so are N and Z.
    if (quotient > 0xffff) {
      this.v = true;
      return;
    }
    const remainder = dividend - quotient * divisor;
    this.d[dn] = ((remainder << 16) | quotient) >>> 0;
    this.v = false;
    this.setNZ(quotient, 2);
  }

  divs(op: number): void {
    const divisor = signed16(this.readEa((op >> 3) & 7, op & 7, 2));
    const dn = (op >> 9) & 7;
    const dividend = this.d[dn] | 0;
    if (divisor === 0) {
      this.zeroDivide();
      return;
    }
    this.cycles += divsTime(dividend, divisor) - 4;
    const quotient = Math.trunc(dividend / divisor);
    this.c = false;
    if (quotient > 0x7fff || quotient < -0x8000) {
      this.v = true;
      return;
    }
    const remainder = dividend - quotient * divisor;
    this.d[dn] = ((remainder << 16) | (quotient & 0xffff)) >>> 0;
    this.v = false;
    this.setNZ(quotient, 2);
  }

  private zeroDivide(): void {
    this.n = false;
    this.z = false;
    this.v = this.c = false;
    this.cycles += 4;
    this.exception(VECTOR_ZERO_DIVIDE, this.pc);
  }

  /** EXG: Dx and Dy, Ax and Ay, or Dx and Ay. */
  exg(op: number): void {
    const rx = (op >> 9) & 7;
    const ry = op & 7;
    const mode = (op >> 3) & 0x1f;
    this.cycles += 2;
    if (mode === 0x08) {
      const t = this.d[rx];
      this.d[rx] = this.d[ry];
      this.d[ry] = t;
    } else if (mode === 0x09) {
      const t = this.a[rx];
      this.a[rx] = this.a[ry];
      this.a[ry] = t;
    } else {
      const t = this.d[rx];
      this.d[rx] = this.a[ry];
      this.a[ry] = t;
    }
  }

  /** ASL, ASR, LSL, LSR, ROXL, ROXR, ROL and ROR on a data register, by 1-8 or by a register (mod 64). */
  shiftRegister(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const field = (op >> 9) & 7;
    const count = op & 0x20 ? this.d[field] & 63 : field || 8;
    const reg = op & 7;
    this.cycles += (size === 4 ? 4 : 2) + 2 * count;
    this.setD(reg, size, this.shift((op >> 3) & 3, (op & 0x100) !== 0, wrap(this.d[reg], size), count, size));
  }

  /** The same shifts by one place on a word in memory. */
  shiftMemory(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 2);
    this.writeBack(mode, reg, 2, this.shift((op >> 9) & 3, (op & 0x100) !== 0, value, 1, 2));
  }

  private shift(kind: number, left: boolean, value: number, count: number, size: Size): number {
    const msb = MSB[size];
    let result = value;
    let carry = false;
    let overflow = false;
    for (let i = 0; i < count; i++) {
      const top = (result & msb) !== 0;
      const bottom = (result & 1) !== 0;
      if (left) {
        let incoming = 0;
        if (kind === 2) incoming = this.x ? 1 : 0;
        else if (kind === 3) incoming = top ? 1 : 0;
        result = wrap(result * 2 + incoming, size);
        carry = top;
        if (kind === 0 && ((result & msb) !== 0) !== top) overflow = true;
      } else {
        let incoming = false;
        if (kind === 0) incoming = top;
        else if (kind === 2) incoming = this.x;
        else if (kind === 3) incoming = bottom;
        result = wrap(Math.floor(result / 2) + (incoming ? msb : 0), size);
        carry = bottom;
      }
      if (kind !== 3) this.x = carry;
    }
    if (count === 0) carry = kind === 2 ? this.x : false;
    // ASR past the operand's width leaves C and X clear, as the hardware-derived tests record.
    if (kind === 0 && !left && count > size * 8) carry = this.x = false;
    this.c = carry;
    this.v = overflow;
    this.setNZ(result, size);
    return result;
  }
}

/** DIVU's time, from the number of steps its shift-and-subtract loop takes (Jorge Cwik's analysis). */
function divuTime(dividend: number, divisor: number): number {
  if (dividend >>> 16 >= divisor) return 10;
  let cycles = 38;
  const shiftedDivisor = divisor * 0x10000;
  let remainder = dividend;
  for (let i = 0; i < 15; i++) {
    const wasNegative = remainder >= 0x80000000;
    remainder = (remainder * 2) % 0x100000000;
    if (wasNegative) {
      remainder = (remainder - shiftedDivisor + 0x100000000) % 0x100000000;
    } else {
      cycles += 2;
      if (remainder >= shiftedDivisor) {
        remainder -= shiftedDivisor;
        cycles--;
      }
    }
  }
  return cycles * 2;
}

/** DIVS's time: a fixed part, the signs, and the bits of the absolute quotient (Jorge Cwik's analysis). */
function divsTime(dividend: number, divisor: number): number {
  let cycles = 6;
  if (dividend < 0) cycles++;
  const absDividend = Math.abs(dividend);
  const absDivisor = Math.abs(divisor);
  let quotient = Math.floor(absDividend / absDivisor);
  // An overflow (of the absolute value, or of the signed quotient) ends the division early.
  const negativeQuotient = dividend < 0 !== divisor < 0;
  if (quotient > (negativeQuotient ? 0x8000 : 0x7fff)) return (cycles + 2) * 2;
  cycles += 55;
  if (divisor >= 0) cycles += dividend >= 0 ? -1 : 1;
  for (let i = 0; i < 15; i++) {
    if (!(quotient & 0x8000)) cycles++;
    quotient = (quotient << 1) & 0xffff;
  }
  return cycles * 2;
}

// --- Decoding ---------------------------------------------------------------------------

const P = M68k.prototype;

function decodeLine0(op: number, mode: number, reg: number): Handler {
  if (op & 0x100) {
    if (mode === 1) return P.movep;
    const kind = (op >> 6) & 3;
    if (kind === 0 ? isDataEa(mode, reg) : isDataAlterable(mode, reg)) return P.bitOp;
    return P.illegal;
  }
  const kind = (op >> 9) & 7;
  if (kind === 4) {
    const bit = (op >> 6) & 3;
    const valid = bit === 0 ? isDataEa(mode, reg) && !(mode === 7 && reg === 4) : isDataAlterable(mode, reg);
    return valid ? P.bitOp : P.illegal;
  }
  if (kind === 7) return P.illegal;
  const size = (op >> 6) & 3;
  if ((kind === 0 || kind === 1 || kind === 5) && mode === 7 && reg === 4) {
    return size < 2 ? P.immediateToStatus : P.illegal;
  }
  if (size === 3 || !isDataAlterable(mode, reg)) return P.illegal;
  return P.immediate;
}

function decodeMove(op: number, mode: number, reg: number): Handler {
  const destMode = (op >> 6) & 7;
  const destReg = (op >> 9) & 7;
  const byte = op >> 12 === 1;
  if (!isValidEa(mode, reg) || (byte && mode === 1)) return P.illegal;
  if (destMode === 1) return byte ? P.illegal : P.movea;
  return isDataAlterable(destMode, destReg) ? P.move : P.illegal;
}

function decodeLine4(op: number, mode: number, reg: number): Handler {
  if (op & 0x100) {
    const kind = (op >> 6) & 3;
    if (kind === 3) return isControl(mode, reg) ? P.lea : P.illegal;
    if (kind === 2) return isDataEa(mode, reg) ? P.chk : P.illegal;
    return P.illegal;
  }
  const size = (op >> 6) & 3;
  switch ((op >> 8) & 0xf) {
    case 0x0:
      if (!isDataAlterable(mode, reg)) return P.illegal;
      return size === 3 ? P.moveFromSr : P.unary;
    case 0x2:
      return size !== 3 && isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x4:
      if (size === 3) return isDataEa(mode, reg) ? P.moveToCcr : P.illegal;
      return isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x6:
      if (size === 3) return isDataEa(mode, reg) ? P.moveToSr : P.illegal;
      return isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x8:
      if (size === 0) return isDataAlterable(mode, reg) ? P.nbcd : P.illegal;
      if (mode === 0) return size === 1 ? P.swap : P.ext;
      if (size === 1) return isControl(mode, reg) ? P.pea : P.illegal;
      return isControl(mode, reg) && !(mode === 7 && reg >= 2) ? P.movem : mode === 4 ? P.movem : P.illegal;
    case 0xa:
      if (size === 3) {
        if (op === 0x4afc) return P.illegal;
        return isDataAlterable(mode, reg) ? P.tas : P.illegal;
      }
      return isDataAlterable(mode, reg) ? P.tst : P.illegal;
    case 0xc:
      if (size < 2) return P.illegal;
      return isControl(mode, reg) || mode === 3 ? P.movem : P.illegal;
    case 0xe:
      return decodeLine4e(op, mode, reg);
    default:
      return P.illegal;
  }
}

function decodeLine4e(op: number, mode: number, reg: number): Handler {
  if ((op & 0xffc0) === 0x4e80) return isControl(mode, reg) ? P.jsr : P.illegal;
  if ((op & 0xffc0) === 0x4ec0) return isControl(mode, reg) ? P.jmp : P.illegal;
  if ((op & 0xfff0) === 0x4e40) return P.trap;
  if ((op & 0xfff8) === 0x4e50) return P.link;
  if ((op & 0xfff8) === 0x4e58) return P.unlk;
  if ((op & 0xfff0) === 0x4e60) return P.moveUsp;
  switch (op) {
    case 0x4e70:
      return P.resetInstruction;
    case 0x4e71:
      return P.nop;
    case 0x4e72:
      return P.stop;
    case 0x4e73:
      return P.rte;
    case 0x4e75:
      return P.rts;
    case 0x4e76:
      return P.trapv;
    case 0x4e77:
      return P.rtr;
    default:
      return P.illegal;
  }
}

function decodeLine5(op: number, mode: number, reg: number): Handler {
  if (((op >> 6) & 3) === 3) {
    if (mode === 1) return P.dbcc;
    return isDataAlterable(mode, reg) ? P.scc : P.illegal;
  }
  if (!isAlterable(mode, reg) || (mode === 1 && ((op >> 6) & 3) === 0)) return P.illegal;
  return P.quick;
}

/** OR/AND (line 8 and C) and SUB/ADD (line 9 and D): the plain forms after the special ones are taken out. */
function decodeArithmetic(op: number, mode: number, reg: number, logical: boolean): Handler {
  const size = (op >> 6) & 3;
  if (op & 0x100) return isMemoryAlterable(mode, reg) ? P.arithmetic : P.illegal;
  if (logical) return isDataEa(mode, reg) ? P.arithmetic : P.illegal;
  if (!isValidEa(mode, reg) || (size === 0 && mode === 1)) return P.illegal;
  return P.arithmetic;
}

function decodeLine8(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isDataEa(mode, reg) ? P.divu : P.illegal;
  if (opmode === 7) return isDataEa(mode, reg) ? P.divs : P.illegal;
  if ((op & 0x1f0) === 0x100) return P.extended;
  return decodeArithmetic(op, mode, reg, true);
}

function decodeAddSub(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return isValidEa(mode, reg) ? P.addressArithmetic : P.illegal;
  if ((op & 0x130) === 0x100) return P.extended;
  return decodeArithmetic(op, mode, reg, false);
}

function decodeLineB(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return isValidEa(mode, reg) ? P.addressArithmetic : P.illegal;
  if (opmode < 3) return isValidEa(mode, reg) && !(opmode === 0 && mode === 1) ? P.cmp : P.illegal;
  if (mode === 1) return P.cmpm;
  return isDataAlterable(mode, reg) ? P.eor : P.illegal;
}

function decodeLineC(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isDataEa(mode, reg) ? P.mulu : P.illegal;
  if (opmode === 7) return isDataEa(mode, reg) ? P.muls : P.illegal;
  if ((op & 0x1f0) === 0x100) return P.extended;
  const exg = op & 0x1f8;
  if (exg === 0x140 || exg === 0x148 || exg === 0x188) return P.exg;
  return decodeArithmetic(op, mode, reg, true);
}

function decodeLineE(op: number, mode: number, reg: number): Handler {
  if (((op >> 6) & 3) === 3) {
    if (op & 0x800) return P.illegal;
    return isMemoryAlterable(mode, reg) ? P.shiftMemory : P.illegal;
  }
  return P.shiftRegister;
}

function decode(op: number): Handler {
  const mode = (op >> 3) & 7;
  const reg = op & 7;
  switch (op >> 12) {
    case 0x0:
      return decodeLine0(op, mode, reg);
    case 0x1:
    case 0x2:
    case 0x3:
      return decodeMove(op, mode, reg);
    case 0x4:
      return decodeLine4(op, mode, reg);
    case 0x5:
      return decodeLine5(op, mode, reg);
    case 0x6:
      return P.branch;
    case 0x7:
      return op & 0x100 ? P.illegal : P.moveq;
    case 0x8:
      return decodeLine8(op, mode, reg);
    case 0x9:
    case 0xd:
      return decodeAddSub(op, mode, reg);
    case 0xa:
      return P.lineA;
    case 0xb:
      return decodeLineB(op, mode, reg);
    case 0xc:
      return decodeLineC(op, mode, reg);
    case 0xe:
      return decodeLineE(op, mode, reg);
    default:
      return P.lineF;
  }
}

const OPCODES: Handler[] = Array.from({ length: 0x10000 }, (_, op) => decode(op));
