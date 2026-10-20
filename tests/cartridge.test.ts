import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { detectRom } from '../src/cart/detect';
import { buildRom } from './helpers/rom';

/** The Super Magic Drive layout: a 512-byte header, then each 16K block as its odd bytes then its even bytes. */
function toSmd(rom: Uint8Array): Uint8Array {
  const smd = new Uint8Array(0x200 + rom.length);
  smd[8] = 0xaa;
  smd[9] = 0xbb;
  for (let block = 0; block < rom.length; block += 0x4000) {
    for (let i = 0; i < 0x2000; i++) {
      smd[0x200 + block + i] = rom[block + i * 2 + 1];
      smd[0x200 + block + 0x2000 + i] = rom[block + i * 2];
    }
  }
  return smd;
}

describe('cartridge images', () => {
  it('reads the title, regions and save RAM from the header', () => {
    const info = detectRom(buildRom([], { regions: 'E', saveRam: [0x200001, 0x203fff] }));
    expect(info.title).toBe('TEST PROGRAM');
    expect(info.hasHeader).toBe(true);
    expect([info.region, info.tv]).toEqual(['export', 'pal']);
    expect(info.saveRam).toEqual({ start: 0x200001, end: 0x203fff });
  });

  it('prefers an American console, then a Japanese one', () => {
    expect(detectRom(buildRom([], { regions: 'JUE' })).tv).toBe('ntsc');
    expect(detectRom(buildRom([], { regions: 'JE' })).region).toBe('japan');
    // Newer headers give a hex digit of flags: 8 is Europe only.
    expect(detectRom(buildRom([], { regions: '8' })).tv).toBe('pal');
  });

  it('lets the file name decide the region', () => {
    const info = detectRom(buildRom([], { regions: 'JUE' }), 'Some Game (Europe).md');
    expect([info.region, info.tv]).toEqual(['export', 'pal']);
  });

  it('undoes the .smd interleaving and copier header', () => {
    const rom = buildRom([0x4e71, 0x4e75]);
    const info = detectRom(toSmd(rom), 'game.smd');
    expect(info.interleaved).toBe(true);
    expect(info.rom).toEqual(rom);
  });

  it('strips a copier header from a plain image', () => {
    const rom = buildRom([]);
    const withHeader = new Uint8Array(0x200 + rom.length);
    withHeader.set(rom, 0x200);
    expect(detectRom(withHeader).rom).toEqual(rom);
  });
});

describe('cartridge', () => {
  it('repeats a ROM that is not a power of two in size', () => {
    const image = new Uint8Array(0x30000).map((_, i) => i >> 16);
    const cart = new Cartridge(image, null);
    expect(cart.read8(0x30000)).toBe(0);
    expect(cart.read8(0x20000)).toBe(2);
  });

  it('keeps save RAM, and offers it as a save once the game has written it', () => {
    const cart = new Cartridge(buildRom([]), { start: 0x200001, end: 0x203fff });
    expect(cart.saveData).toBeNull();
    cart.write8(0x200001, 0x42);
    expect(cart.read8(0x200001)).toBe(0x42);
    expect(cart.batteryDirty).toBe(true);
    // Saved from the start of the 64K page, as other emulators do.
    expect(cart.saveData?.[1]).toBe(0x42);
  });

  it('switches save RAM in over the ROM of games over 2M', () => {
    const image = new Uint8Array(0x300000).fill(0x11);
    const cart = new Cartridge(image, { start: 0x200001, end: 0x20ffff });
    cart.write8(0x200001, 0x42);
    expect(cart.read8(0x200001)).toBe(0x11);
    cart.writeRegister(0xa130f1, 1);
    cart.write8(0x200001, 0x42);
    expect(cart.read8(0x200001)).toBe(0x42);
    cart.writeRegister(0xa130f1, 3);
    cart.write8(0x200001, 0x55);
    expect(cart.read8(0x200001)).toBe(0x42);
  });

  it('switches 512K banks on games over 4M', () => {
    const image = new Uint8Array(0x500000).map((_, i) => i >> 19);
    const cart = new Cartridge(image, null);
    expect(cart.read8(0x380000)).toBe(7);
    cart.writeRegister(0xa130ff, 9);
    expect(cart.read8(0x380000)).toBe(9);
    expect(cart.read8(0x000000)).toBe(0);
  });
});
