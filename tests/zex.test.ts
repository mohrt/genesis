import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Z80 } from '../src/cpu/z80';
import { FlatBus } from './helpers/flat-bus';

// The exercisers take a few minutes each, so they run only when asked for: `ZEX=1 npm test`.
const fixtures = join(import.meta.dirname, 'fixtures', 'zex');
const enabled = process.env.ZEX === '1';
const BDOS = 0x0005;
const TPA = 0x0100;

/** Runs a CP/M .com program with just enough of the BDOS (console output) for the exercisers. */
function runCpm(program: Uint8Array): string {
  const bus = new FlatBus();
  bus.load(TPA, program);
  bus.memory[0x0000] = 0x76; // HALT: a warm boot ends the run
  bus.memory[BDOS] = 0xc9; // RET
  bus.memory[0x0006] = 0x00;
  bus.memory[0x0007] = 0xf0; // top of memory, where programs put their stack
  const cpu = new Z80(bus);
  cpu.pc = TPA;
  cpu.sp = 0xf000;
  let output = '';
  while (!cpu.halted) {
    if (cpu.pc === BDOS) {
      if (cpu.c === 2) {
        output += String.fromCharCode(cpu.e);
      } else if (cpu.c === 9) {
        for (let address = cpu.de; bus.memory[address] !== 0x24; address = (address + 1) & 0xffff) {
          output += String.fromCharCode(bus.memory[address]);
        }
      }
    }
    cpu.step();
  }
  return output;
}

for (const name of ['zexdoc', 'zexall']) {
  const path = join(fixtures, `${name}.com`);
  describe.skipIf(!enabled || !existsSync(path))(name, () => {
    it('passes every test', () => {
      const output = runCpm(readFileSync(path));
      console.log(output);
      expect(output).toContain('Tests complete');
      expect(output).not.toContain('ERROR');
    }, 1_800_000);
  });
}
