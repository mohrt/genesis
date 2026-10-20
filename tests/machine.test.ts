import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { Genesis } from '../src/genesis';
import { Button } from '../src/io/controllers';
import { LOOP, buildRom, moveByte, moveByteTo, moveWordTo } from './helpers/rom';

function machineWith(code: number[], setUp: (machine: Genesis) => void = () => {}): Genesis {
  const machine = new Genesis();
  setUp(machine);
  machine.insertCartridge(new Cartridge(buildRom([...code, ...LOOP]), null));
  return machine;
}

describe('Genesis', () => {
  it('starts the cartridge from its reset vector', () => {
    const machine = machineWith([...moveByteTo(0x42, 0xff0000)]);
    machine.runFrame();
    expect(machine.bus.ram[0]).toBe(0x42);
  });

  it('reports its region and TV system in the version register', () => {
    const version = (region: 'export' | 'japan', tv: 'ntsc' | 'pal') => {
      const machine = machineWith(moveByte(0xa10001, 0xff0000), (m) => {
        m.setRegion(region);
        m.setTv(tv);
      });
      machine.runFrame();
      return machine.bus.ram[0];
    };
    expect(version('export', 'ntsc')).toBe(0xa0);
    expect(version('export', 'pal')).toBe(0xe0);
    expect(version('japan', 'ntsc')).toBe(0x20);
  });

  it('lets the 68000 load a program into the Z80 and start it', () => {
    // LD A,$42; LD ($1000),A; JR -2
    const z80Program = [0x3e, 0x42, 0x32, 0x00, 0x10, 0x18, 0xfe];
    const machine = machineWith([
      ...moveWordTo(0x0100, 0xa11100),
      ...moveWordTo(0x0100, 0xa11200),
      ...z80Program.flatMap((byte, i) => moveByteTo(byte, 0xa00000 + i)),
      ...moveWordTo(0x0000, 0xa11200),
      ...moveWordTo(0x0000, 0xa11100),
      ...moveWordTo(0x0100, 0xa11200),
    ]);
    machine.runFrame();
    expect(machine.bus.z80Ram[0x1000]).toBe(0x42);
  });

  it('reads the pads through the I/O ports', () => {
    const machine = machineWith([
      ...moveByteTo(0x40, 0xa10009),
      ...moveByteTo(0x40, 0xa10003),
      ...moveByte(0xa10003, 0xff0000),
      ...moveByteTo(0x00, 0xa10003),
      ...moveByte(0xa10003, 0xff0001),
    ]);
    machine.controllers.inputs[0].set('test', { buttons: Button.Right | Button.Start });
    machine.runFrame();
    expect(machine.bus.ram[0] & 0x7f).toBe(0x77);
    expect(machine.bus.ram[1] & 0x7f).toBe(0x13);
  });

  it('runs a frame in 262 lines (313 on PAL) at the VDP interrupt rate', () => {
    const machine = machineWith([]);
    const start = machine.vdp.frames;
    for (let line = 0; line < 262 * 10; line++) machine.runLine();
    expect(machine.vdp.frames - start).toBe(10);
  });

  it('restores a saved state exactly', () => {
    const machine = machineWith([0x5279, 0x00ff, 0x0000, 0x60f8]);
    for (let frame = 0; frame < 5; frame++) machine.runFrame();
    const state = machine.saveState();
    const counter = machine.bus.ram[1];
    for (let frame = 0; frame < 5; frame++) machine.runFrame();
    const later = machine.bus.ram[1];
    machine.loadState(state);
    expect(machine.bus.ram[1]).toBe(counter);
    for (let frame = 0; frame < 5; frame++) machine.runFrame();
    expect(machine.bus.ram[1]).toBe(later);
  });

  it('starts through a boot ROM, which switches the cartridge in', () => {
    // The boot ROM writes $A14101 = 1 (cartridge in) from RAM-resident code... here, directly, then jumps to the cartridge's code.
    const boot = new Uint8Array(0x800);
    const view = new DataView(boot.buffer);
    view.setUint32(0, 0x00fffe00);
    view.setUint32(4, 0x00000100);
    const code = [...moveByteTo(0x55, 0xff0002), 0x4ef9, 0x00ff, 0x0010];
    code.forEach((word, i) => view.setUint16(0x100 + i * 2, word));
    const machine = machineWith(moveByteTo(0x42, 0xff0000), (m) => m.setBootRom(boot));
    // RAM code at $FF0010: switch the cartridge in and jump to its entry point.
    const ram = [...moveByteTo(0x01, 0xa14101), 0x4ef9, 0x0000, 0x0200];
    ram.forEach((word, i) => {
      machine.bus.ram[0x10 + i * 2] = word >> 8;
      machine.bus.ram[0x11 + i * 2] = word & 0xff;
    });
    machine.runFrame();
    expect(machine.bus.ram[2]).toBe(0x55);
    expect(machine.bus.ram[0]).toBe(0x42);
  });
});
