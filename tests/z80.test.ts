import { describe, expect, it } from 'vitest';
import { FLAG_C, FLAG_H, FLAG_N, FLAG_PV, FLAG_S, FLAG_Z, Z80 } from '../src/cpu/z80';
import { FlatBus } from './helpers/flat-bus';

function machine(program: number[], at = 0) {
  const bus = new FlatBus();
  bus.load(at, program);
  const cpu = new Z80(bus);
  cpu.pc = at;
  return { bus, cpu };
}

/** The T-states of each instruction in `program`, run from address 0. */
function timings(program: number[], count: number, setup: (cpu: Z80) => void = () => {}): number[] {
  const { cpu } = machine(program);
  setup(cpu);
  return Array.from({ length: count }, () => cpu.step());
}

describe('Z80 timing', () => {
  it('counts T-states for plain, prefixed and indexed instructions', () => {
    // NOP; LD BC,nn; LD A,(HL); INC (HL); LD (IX+1),5; LD B,(IX+2); INC (IY+0); BIT 0,(IX+1); RLC (IX+1); PUSH IX
    const program = [0x00, 0x01, 0x34, 0x12, 0x7e, 0x34, 0xdd, 0x36, 1, 5, 0xdd, 0x46, 2, 0xfd, 0x34, 0, 0xdd, 0xcb, 1, 0x46, 0xdd, 0xcb, 1, 0x06, 0xdd, 0xe5];
    expect(timings(program, 10, (cpu) => (cpu.hl = 0x8000))).toEqual([4, 10, 7, 11, 19, 19, 23, 20, 23, 15]);
  });

  it('adds time for taken branches', () => {
    // LD B,2; DJNZ -2 (taken, then not); JR Z (not taken, Z clear after LD); RET Z not taken
    const program = [0x06, 0x02, 0x10, 0xfe, 0x28, 0x00, 0xc8];
    expect(timings(program, 5, (cpu) => (cpu.f = 0))).toEqual([7, 13, 8, 7, 5]);
  });

  it('repeats LDIR with 21 T-states per byte and 16 for the last', () => {
    const { bus, cpu } = machine([0xed, 0xb0]);
    bus.load(0x4000, [1, 2, 3]);
    cpu.hl = 0x4000;
    cpu.de = 0x5000;
    cpu.bc = 3;
    expect([cpu.step(), cpu.step(), cpu.step()]).toEqual([21, 21, 16]);
    expect([...bus.memory.subarray(0x5000, 0x5003)]).toEqual([1, 2, 3]);
    expect(cpu.pc).toBe(2);
    expect(cpu.f & FLAG_PV).toBe(0);
  });
});

describe('Z80 arithmetic', () => {
  it('sets overflow and half carry on ADD', () => {
    const { cpu } = machine([0x3e, 0x7f, 0xc6, 0x01]); // LD A,7Fh; ADD A,1
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.f & (FLAG_S | FLAG_PV | FLAG_H | FLAG_Z | FLAG_C | FLAG_N)).toBe(FLAG_S | FLAG_PV | FLAG_H);
  });

  it('adjusts BCD with DAA after an addition and a subtraction', () => {
    const { cpu } = machine([0x3e, 0x19, 0xc6, 0x28, 0x27, 0xd6, 0x09, 0x27]); // 19+28 = 47; 47-09 = 38
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x47);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x38);
  });

  it('computes SBC HL with borrow and zero', () => {
    const { cpu } = machine([0xed, 0x42]); // SBC HL,BC
    cpu.hl = 0x1000;
    cpu.bc = 0x0fff;
    cpu.f = FLAG_C;
    cpu.step();
    expect(cpu.hl).toBe(0);
    expect(cpu.f & (FLAG_Z | FLAG_N | FLAG_C)).toBe(FLAG_Z | FLAG_N);
  });

  it('uses IXH and IXL for undocumented DD-prefixed register operations', () => {
    const { cpu } = machine([0xdd, 0x26, 0x12, 0xdd, 0x2e, 0x34, 0xdd, 0x7c, 0xdd, 0x85]); // LD IXH,12h; LD IXL,34h; LD A,IXH; ADD A,IXL
    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.ix).toBe(0x1234);
    expect(cpu.a).toBe(0x46);
    expect(cpu.hl).toBe(0);
  });
});

describe('Z80 interrupts', () => {
  it('takes an NMI to 0066h, keeping IFF2 for RETN', () => {
    const { bus, cpu } = machine([0xfb, 0x00, 0x00]); // EI; NOP; NOP
    bus.load(0x66, [0xed, 0x45]); // RETN
    cpu.sp = 0x8000;
    cpu.step();
    cpu.nmi();
    expect(cpu.step()).toBe(11);
    expect(cpu.pc).toBe(0x66);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(true);
    cpu.step();
    expect(cpu.pc).toBe(1);
    expect(cpu.iff1).toBe(true);
  });

  it('delays a maskable interrupt until after the instruction following EI', () => {
    const { cpu } = machine([0xed, 0x56, 0xfb, 0x00, 0x00]); // IM 1; EI; NOP; NOP
    cpu.sp = 0x8000;
    cpu.irq = true;
    cpu.step();
    cpu.step();
    cpu.step(); // the NOP after EI runs first
    expect(cpu.pc).toBe(4);
    expect(cpu.step()).toBe(13);
    expect(cpu.pc).toBe(0x38);
  });

  it('wakes from HALT and vectors through I in IM 2', () => {
    const { bus, cpu } = machine([0xed, 0x5e, 0xfb, 0x76]); // IM 2; EI; HALT
    bus.load(0x40fe, [0x00, 0x90]);
    cpu.i = 0x40;
    cpu.irqData = 0xfe;
    cpu.sp = 0x8000;
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.halted).toBe(true);
    expect(cpu.step()).toBe(4);
    cpu.irq = true;
    expect(cpu.step()).toBe(19);
    expect(cpu.pc).toBe(0x9000);
    expect(bus.memory[0x7ffe] | (bus.memory[0x7fff] << 8)).toBe(4);
  });
});

describe('Z80 I/O', () => {
  it('puts A on the high address lines for OUT (n),A and B for OUT (C),r', () => {
    const { bus, cpu } = machine([0x3e, 0x55, 0xd3, 0xbe, 0x01, 0xff, 0x12, 0xed, 0x79]);
    for (let i = 0; i < 4; i++) cpu.step();
    expect(bus.outputs).toEqual([
      [0x55be, 0x55],
      [0x12ff, 0x55],
    ]);
  });
});
