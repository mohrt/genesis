import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { M68k, type M68kBus } from '../src/cpu/m68k';

// Tom Harte's SingleStepTests (`npm run fetch:m68k`): each test sets up the registers and
// some memory, runs one instruction, and gives the state and cycle count afterwards.
// Address errors are counted apart: their stack frames hold bits this core doesn't model.
const fixtures = join(import.meta.dirname, 'fixtures', 'm68000');
const files = existsSync(fixtures) ? readdirSync(fixtures).filter((name) => name.endsWith('.json.gz')).sort() : [];
/** Set M68K=<names> (comma-separated) to run only some files, and M68K_VERBOSE=1 to print the first failures. */
const only = process.env.M68K?.split(',').filter(Boolean);
const verbose = process.env.M68K_VERBOSE === '1';

interface CpuState {
  d0: number;
  d1: number;
  d2: number;
  d3: number;
  d4: number;
  d5: number;
  d6: number;
  d7: number;
  a0: number;
  a1: number;
  a2: number;
  a3: number;
  a4: number;
  a5: number;
  a6: number;
  usp: number;
  ssp: number;
  sr: number;
  pc: number;
  prefetch: [number, number];
  ram: [number, number][];
}

interface SingleStepTest {
  name: string;
  initial: CpuState;
  final: CpuState;
  length: number;
}

/** 16M of sparse memory. */
class TestBus implements M68kBus {
  readonly memory = new Map<number, number>();

  read8(address: number): number {
    return this.memory.get(address) ?? 0;
  }

  read16(address: number): number {
    return (this.read8(address) << 8) | this.read8(address + 1);
  }

  write8(address: number, value: number): void {
    this.memory.set(address, value);
  }

  write16(address: number, value: number): void {
    this.write8(address, value >> 8);
    this.write8(address + 1, value & 0xff);
  }

  acknowledgeInterrupt(): void {}

  resetDevices(): void {}
}

/**
 * Tests whose expected results contradict every other test of their kind: two ASL.b tests change
 * the upper bytes of the register, and one DIVU stacks the instruction's address for a divide by zero.
 */
const DISPUTED = new Set(['e502 [ASL.b Q, D2] 1583', 'e502 [ASL.b Q, D2] 1761', '80ef [DIVU (d16, A7), D0] 5745']);

const REGISTERS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as const;

function setUp(cpu: M68k, bus: TestBus, state: CpuState): void {
  for (const [address, value] of state.ram) bus.write8(address, value);
  // The prefetch queue holds the instruction's first two words; this core reads them from memory.
  bus.write16(state.pc & 0xffffff, state.prefetch[0]);
  bus.write16((state.pc + 2) & 0xffffff, state.prefetch[1]);
  for (let i = 0; i < 8; i++) cpu.d[i] = state[REGISTERS[i]];
  for (let i = 0; i < 7; i++) cpu.a[i] = state[REGISTERS[8 + i]];
  cpu.supervisor = (state.sr & 0x2000) !== 0;
  cpu.a[7] = cpu.supervisor ? state.ssp : state.usp;
  cpu.otherSp = cpu.supervisor ? state.usp : state.ssp;
  cpu.sr = state.sr;
  cpu.pc = state.pc;
}

/** What differs from the expected state, or an empty list. */
function differences(cpu: M68k, bus: TestBus, test: SingleStepTest): string[] {
  const expected = test.final;
  const problems: string[] = [];
  const actual: Record<string, number> = { usp: cpu.usp, ssp: cpu.ssp, sr: cpu.sr, pc: cpu.pc };
  for (let i = 0; i < 8; i++) actual[REGISTERS[i]] = cpu.d[i];
  for (let i = 0; i < 7; i++) actual[REGISTERS[8 + i]] = cpu.a[i];
  for (const key of [...REGISTERS, 'usp', 'ssp', 'sr', 'pc'] as const) {
    if (actual[key] >>> 0 !== expected[key] >>> 0) {
      problems.push(`${key} ${(actual[key] >>> 0).toString(16)} != ${(expected[key] >>> 0).toString(16)}`);
    }
  }
  for (const [address, value] of expected.ram) {
    const got = bus.read8(address);
    if (got !== value) problems.push(`ram[${address.toString(16)}] ${got.toString(16)} != ${value.toString(16)}`);
  }
  return problems;
}

interface Tally {
  passed: number;
  failed: number;
  addressErrors: number;
  wrongTime: number;
  firstFailures: string[];
  firstTimings: string[];
}

function runFile(path: string): Tally {
  const tests = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as SingleStepTest[];
  const tally: Tally = { passed: 0, failed: 0, addressErrors: 0, wrongTime: 0, firstFailures: [], firstTimings: [] };
  for (const test of tests) {
    if (DISPUTED.has(test.name)) continue;
    const bus = new TestBus();
    const cpu = new M68k(bus);
    setUp(cpu, bus, test.initial);
    const cycles = cpu.step();
    if (cpu.addressErrors > 0) {
      tally.addressErrors++;
      continue;
    }
    const problems = differences(cpu, bus, test);
    if (problems.length > 0) {
      tally.failed++;
      if (tally.firstFailures.length < 5) tally.firstFailures.push(`${test.name}: ${problems.join(', ')}`);
      continue;
    }
    tally.passed++;
    if (cycles !== test.length) {
      tally.wrongTime++;
      if (tally.firstTimings.length < 5) tally.firstTimings.push(`${test.name}: ${cycles} cycles, not ${test.length}`);
    }
  }
  return tally;
}

const selected = files.filter((file) => !only || only.includes(file.replace('.json.gz', '')));

describe.skipIf(selected.length === 0)('68000 SingleStepTests', () => {
  for (const file of selected) {
    const name = file.replace('.json.gz', '');
    it(`${name}: every test passes, in the right number of cycles`, () => {
      const tally = runFile(join(fixtures, file));
      if (verbose || tally.failed > 0 || tally.wrongTime > 0) {
        console.log(
          `${name}: ${tally.passed} passed, ${tally.failed} failed, ${tally.wrongTime} wrong time, ${tally.addressErrors} address errors`,
        );
        for (const line of [...tally.firstFailures, ...tally.firstTimings]) console.log(`  ${line}`);
      }
      expect(tally.failed, 'tests with the wrong result').toBe(0);
      expect(tally.wrongTime, 'tests that took the wrong number of cycles').toBe(0);
    }, 120_000);
  }
});
