import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_WIDTH, SHADE_HIGHLIGHT, SHADE_SHADOW, Vdp } from '../src/vdp/vdp';

const setRegister = (vdp: Vdp, reg: number, value: number) => vdp.writeControl(0x8000 | (reg << 8) | value);
/** Points the VDP at an address for writing: code 1 VRAM, 3 CRAM, 5 VSRAM (with 0x20 for DMA). */
const target = (vdp: Vdp, code: number, address: number) => {
  vdp.writeControl(((code & 3) << 14) | (address & 0x3fff));
  return vdp.writeControl(((code & 0x3c) << 2) | (address >> 14));
};
const writeVram = (vdp: Vdp, address: number, words: number[]) => {
  target(vdp, 1, address);
  for (const word of words) vdp.writeData(word);
};
const setColor = (vdp: Vdp, index: number, color: number) => {
  target(vdp, 3, index * 2);
  vdp.writeData(color);
};
/** A tile of one colour. */
const solidTile = (vdp: Vdp, tile: number, color: number) => writeVram(vdp, tile * 32, new Array(16).fill(color * 0x1111));
/** Runs to the start of line `line` (drawing the lines before it), with each line's horizontal blanking. */
const runToLine = (vdp: Vdp, line: number) => {
  do {
    vdp.startHblank();
    vdp.startLine();
  } while (vdp.line !== line);
};

const RED = 0x000e;
const GREEN = 0x00e0;
const BLUE = 0x0e00;
/** Those colours as framebuffer values (3 bits each, red lowest). */
const PACKED_RED = 0x007;
const PACKED_GREEN = 0x038;
const PACKED_BLUE = 0x1c0;

let vdp: Vdp;
let level = 0;

beforeEach(() => {
  vdp = new Vdp();
  vdp.onInterrupt = (value) => (level = value);
  vdp.reset();
  setRegister(vdp, 1, 0x44); // display on, mode 5
  setRegister(vdp, 2, 0x30); // plane A at $C000
  setRegister(vdp, 3, 0x2c); // window at $B000
  setRegister(vdp, 4, 0x07); // plane B at $E000
  setRegister(vdp, 5, 0x78); // sprites at $F000
  setRegister(vdp, 12, 0x81); // H40
  setRegister(vdp, 13, 0x3f); // horizontal scroll at $FC00
  setRegister(vdp, 15, 2);
  setColor(vdp, 1, RED);
  setColor(vdp, 2, GREEN);
  setColor(vdp, 3, BLUE);
  solidTile(vdp, 1, 1);
  solidTile(vdp, 2, 2);
  solidTile(vdp, 3, 3);
});

describe('VDP ports', () => {
  it('writes VRAM through the data port, with the auto-increment', () => {
    writeVram(vdp, 0x1000, [0x1234, 0x5678]);
    expect([...vdp.vram.subarray(0x1000, 0x1004)]).toEqual([0x12, 0x34, 0x56, 0x78]);
  });

  it('swaps the bytes of a word written to an odd address', () => {
    writeVram(vdp, 0x2001, [0x1234]);
    expect([vdp.vram[0x2000], vdp.vram[0x2001]]).toEqual([0x34, 0x12]);
  });

  it('reads VRAM back', () => {
    writeVram(vdp, 0x3000, [0xbeef]);
    vdp.writeControl(0x3000);
    vdp.writeControl(0x0000);
    expect(vdp.readData()).toBe(0xbeef);
  });

  it('reports PAL, the vertical blanking and a pending vertical interrupt in its status', () => {
    vdp.pal = true;
    runToLine(vdp, 224);
    const status = vdp.readStatus();
    expect(status & 0x89).toBe(0x89);
  });
});

describe('VDP DMA', () => {
  it('copies 68000 memory to CRAM', () => {
    setRegister(vdp, 1, 0x54);
    vdp.dmaRead = (address) => address & 0xfff;
    const source = 0xff0100;
    setRegister(vdp, 19, 4);
    setRegister(vdp, 20, 0);
    setRegister(vdp, 21, (source >> 1) & 0xff);
    setRegister(vdp, 22, (source >> 9) & 0xff);
    setRegister(vdp, 23, (source >> 17) & 0x7f);
    const stall = target(vdp, 0x23, 0);
    expect([...vdp.cram.subarray(0, 4)]).toEqual([0x100, 0x102, 0x104, 0x106].map((value) => value & 0xeee));
    expect(stall).toBeGreaterThan(0);
  });

  it('fills VRAM with the high byte of the data word', () => {
    setRegister(vdp, 1, 0x54);
    setRegister(vdp, 15, 1);
    setRegister(vdp, 19, 8);
    setRegister(vdp, 23, 0x80);
    target(vdp, 0x21, 0x4000);
    vdp.writeData(0xab00);
    expect([...vdp.vram.subarray(0x4000, 0x4008)]).toEqual(new Array(8).fill(0xab));
  });

  it('copies VRAM to VRAM', () => {
    writeVram(vdp, 0x5000, [0x0102, 0x0304]);
    setRegister(vdp, 1, 0x54);
    setRegister(vdp, 15, 1);
    setRegister(vdp, 19, 4);
    setRegister(vdp, 21, 0x00);
    setRegister(vdp, 22, 0x50);
    setRegister(vdp, 23, 0xc0);
    // Code 0x30 is a VRAM copy; the destination is $6000.
    vdp.writeControl(0x2000);
    vdp.writeControl(0x00c1);
    expect([...vdp.vram.subarray(0x6000, 0x6004)]).toEqual([1, 2, 3, 4]);
  });
});

describe('VDP drawing', () => {
  const pixel = (x: number, line = 0) => vdp.framebuffer[line * MAX_WIDTH + x];

  it('draws plane A over plane B over the background colour', () => {
    writeVram(vdp, 0xc000, [0x0001]);
    writeVram(vdp, 0xe000, [0x0002, 0x0002]);
    runToLine(vdp, 1);
    expect([pixel(0), pixel(8), pixel(16)]).toEqual([PACKED_RED, PACKED_GREEN, 0]);
  });

  it('puts a high-priority plane B tile in front of plane A', () => {
    writeVram(vdp, 0xc000, [0x0001]);
    writeVram(vdp, 0xe000, [0x8002]);
    runToLine(vdp, 1);
    expect(pixel(0)).toBe(PACKED_GREEN);
  });

  it('scrolls plane A horizontally', () => {
    writeVram(vdp, 0xc000, [0x0001]);
    writeVram(vdp, 0xfc00, [4]);
    runToLine(vdp, 1);
    expect([pixel(3), pixel(4), pixel(11), pixel(12)]).toEqual([0, PACKED_RED, PACKED_RED, 0]);
  });

  it('draws sprites, the first in the list in front', () => {
    // Sprite 0 (link 1) at x 16 in green, sprite 1 at x 20 in blue.
    writeVram(vdp, 0xf000, [128, 0x0001, 0x0002, 128 + 16, 128, 0x0000, 0x0003, 128 + 20]);
    runToLine(vdp, 1);
    expect([pixel(16), pixel(23), pixel(24), pixel(27)]).toEqual([PACKED_GREEN, PACKED_GREEN, PACKED_BLUE, PACKED_BLUE]);
    expect(vdp.readStatus() & 0x20).toBe(0x20);
  });

  it('shows the window in place of plane A', () => {
    writeVram(vdp, 0xc000, new Array(4).fill(0x0001));
    writeVram(vdp, 0xb000, [0x0003, 0x0003]);
    setRegister(vdp, 17, 0x01); // window left of x = 16
    runToLine(vdp, 1);
    expect([pixel(0), pixel(15), pixel(16)]).toEqual([PACKED_BLUE, PACKED_BLUE, PACKED_RED]);
  });

  it('shadows low-priority pixels, and lets sprites highlight what is under them', () => {
    setRegister(vdp, 12, 0x89);
    solidTile(vdp, 4, 14);
    solidTile(vdp, 5, 14);
    writeVram(vdp, 0xc000, [0x0001, 0x8001]);
    runToLine(vdp, 1);
    expect([pixel(0), pixel(8)]).toEqual([PACKED_RED | SHADE_SHADOW, PACKED_RED]);
    // A high-priority two-cell sprite in palette 3's colour 14 over x 0-15 is the highlight operator.
    writeVram(vdp, 0xf000, [128, 0x0400, 0xe004, 128]);
    runToLine(vdp, 1);
    expect([pixel(0), pixel(8)]).toEqual([PACKED_RED, PACKED_RED | SHADE_HIGHLIGHT]);
  });
});

describe('VDP interrupts', () => {
  it('raises the vertical interrupt at the bottom of the picture until it is taken', () => {
    setRegister(vdp, 1, 0x64);
    runToLine(vdp, 224);
    expect(level).toBe(6);
    vdp.acknowledge(6);
    expect(level).toBe(0);
  });

  it('raises the horizontal interrupt every R10 + 1 lines', () => {
    setRegister(vdp, 0, 0x14);
    setRegister(vdp, 10, 3);
    runToLine(vdp, 0);
    const lines: number[] = [];
    for (let line = 0; line < 12; line++) {
      vdp.startHblank();
      if (vdp.hintPending) lines.push(vdp.line);
      vdp.acknowledge(4);
      vdp.startLine();
    }
    expect(lines).toEqual([3, 7, 11]);
  });
});
