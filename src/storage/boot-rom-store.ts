import type { KeyValueStore } from './store';

const KEY = 'tmss';
/** The TMSS boot ROM of the later consoles is 2K. */
export const BOOT_ROM_SIZE = 0x800;

/** File names that say they are a boot ROM or BIOS, so a dropped one isn't taken for a game. */
export function looksLikeBootRom(fileName: string): boolean {
  return /\b(bios|tmss|boot)\b|(bios|tmss|boot)[\s._-]/i.test(fileName);
}

/** Checks a boot ROM image: 2K, starting with a vector table like any 68000 program. */
export function checkBootRom(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== BOOT_ROM_SIZE) {
    throw new Error(`That file (${bytes.length} bytes) isn't a TMSS boot ROM, which is 2K.`);
  }
  return bytes;
}

/** The player's boot ROM, kept in browser storage so it only has to be given once. */
export class BootRomStore {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  async load(): Promise<Uint8Array | null> {
    return (await this.store.get(KEY)) ?? null;
  }

  save(bytes: Uint8Array): Promise<void> {
    return this.store.put(KEY, bytes.slice());
  }

  forget(): Promise<void> {
    return this.store.delete(KEY);
  }
}
