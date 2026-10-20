import type { Z80Bus } from '../../src/cpu/z80';

/** 64K of plain RAM with logged I/O, for testing the Z80 in isolation. */
export class FlatBus implements Z80Bus {
  readonly memory = new Uint8Array(0x10000);
  readonly outputs: [number, number][] = [];
  inputValue = 0xff;

  read(address: number): number {
    return this.memory[address];
  }

  write(address: number, value: number): void {
    this.memory[address] = value;
  }

  input(): number {
    return this.inputValue;
  }

  output(port: number, value: number): void {
    this.outputs.push([port, value]);
  }

  load(address: number, bytes: ArrayLike<number>): void {
    this.memory.set(bytes, address);
  }
}
