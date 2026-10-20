/** A cartridge image with a Sega header, the vectors pointing at `code` (at $200), and the rest of the space empty. */
export function buildRom(code: number[], options: { size?: number; regions?: string; saveRam?: [number, number] } = {}): Uint8Array {
  const rom = new Uint8Array(options.size ?? 0x10000);
  const view = new DataView(rom.buffer);
  view.setUint32(0, 0x00fffe00);
  view.setUint32(4, 0x00000200);
  // Every other vector points at an RTE, so stray interrupts return.
  for (let vector = 2; vector < 64; vector++) view.setUint32(vector * 4, 0x000001fe);
  view.setUint16(0x1fe, 0x4e73);
  const ascii = (at: number, text: string) => [...text].forEach((char, i) => (rom[at + i] = char.charCodeAt(0)));
  ascii(0x100, 'SEGA GENESIS    ');
  ascii(0x150, 'TEST PROGRAM'.padEnd(48));
  ascii(0x1f0, (options.regions ?? 'JUE').padEnd(3));
  if (options.saveRam) {
    ascii(0x1b0, 'RA');
    rom[0x1b2] = 0xf8;
    rom[0x1b3] = 0x20;
    view.setUint32(0x1b4, options.saveRam[0]);
    view.setUint32(0x1b8, options.saveRam[1]);
  }
  code.forEach((word, i) => view.setUint16(0x200 + i * 2, word));
  return rom;
}

/** The instruction words for `move.w #value,(address).l`. */
export const moveWordTo = (value: number, address: number) => [0x33fc, value, address >>> 16, address & 0xffff];
/** `move.b #value,(address).l`. */
export const moveByteTo = (value: number, address: number) => [0x13fc, value & 0xff, address >>> 16, address & 0xffff];
/** `move.b (from).l,(to).l`. */
export const moveByte = (from: number, to: number) => [0x13f9, from >>> 16, from & 0xffff, to >>> 16, to & 0xffff];
/** `bra.s *`: wait forever. */
export const LOOP = [0x60fe];
