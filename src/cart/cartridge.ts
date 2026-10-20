import type { SaveRam } from './detect';

/** Cartridges up to 4M are wired straight to the address space; bigger ones switch 512K banks. */
const DIRECT_SIZE = 0x400000;
const BANK_SIZE = 0x80000;
/** Games over 2M share the space above with their save RAM, and switch between the two. */
const SHARED_SIZE = 0x200000;
/** Without a header record, save RAM is offered where most games put it. */
const DEFAULT_SAVE_RAM: SaveRam = { start: 0x200000, end: 0x20ffff };

/** The smallest power of two at least `size`. */
const powerOfTwo = (size: number) => 2 ** Math.ceil(Math.log2(Math.max(size, 2)));

/**
 * A Genesis cartridge: ROM, repeated to fill a power-of-two size as an
 * unconnected address line would; battery-backed save RAM where the header
 * says (or at $200000 for games that don't say); and, for games over 4M
 * (Super Street Fighter II), Sega's bank switcher at $A130F3-$A130FF.
 */
export class Cartridge {
  readonly rom: Uint8Array;
  private readonly romMask: number;
  readonly saveRam: Uint8Array;
  /** The save RAM's address range; its bytes are kept from the start of its 64K page, as other emulators save them. */
  private readonly saveStart: number;
  private readonly saveEnd: number;
  private readonly saveBase: number;
  private readonly sharesRomSpace: boolean;
  private readonly banked: boolean;
  /** $A130F1: bit 0 maps the save RAM (over ROM, on big games), bit 1 protects it from writes. */
  saveRamControl = 0;
  /** The 512K banks in the eight slots of the address space, for big games. */
  readonly banks = Uint8Array.from({ length: 8 }, (_, i) => i);
  /** The game has written its save RAM (or one was loaded), so it is worth keeping. */
  saveUsed = false;
  /** Save RAM changed since it was last stored. */
  batteryDirty = false;

  constructor(image: Uint8Array, saveRam: SaveRam | null) {
    this.banked = image.length > DIRECT_SIZE;
    const size = this.banked ? powerOfTwo(image.length) : Math.min(DIRECT_SIZE, powerOfTwo(image.length));
    this.rom = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += image.length) this.rom.set(image.subarray(0, size - offset), offset);
    this.romMask = size - 1;
    const ram = saveRam ?? (image.length <= SHARED_SIZE ? DEFAULT_SAVE_RAM : null);
    this.saveStart = ram?.start ?? 0;
    this.saveEnd = ram?.end ?? -1;
    this.saveBase = this.saveStart & 0xff0000;
    this.saveRam = new Uint8Array(ram ? this.saveEnd - this.saveBase + 1 : 0);
    this.saveRam.fill(0xff);
    this.sharesRomSpace = image.length > SHARED_SIZE;
  }

  reset(): void {
    this.saveRamControl = 0;
    this.banks.forEach((_, i) => (this.banks[i] = i));
  }

  /** The save RAM as a .sav file, or null until the game has used it. */
  get saveData(): Uint8Array | null {
    return this.saveUsed ? this.saveRam : null;
  }

  loadSaveData(data: Uint8Array): void {
    this.saveRam.fill(0xff);
    this.saveRam.set(data.subarray(0, this.saveRam.length));
    this.saveUsed = true;
  }

  private inSaveRam(address: number): boolean {
    if (address < this.saveStart || address > this.saveEnd) return false;
    return !this.sharesRomSpace || (this.saveRamControl & 1) !== 0;
  }

  private romAddress(address: number): number {
    if (!this.banked) return address & this.romMask;
    return ((this.banks[address >> 19] * BANK_SIZE) | (address & (BANK_SIZE - 1))) & this.romMask;
  }

  read8(address: number): number {
    if (this.inSaveRam(address)) return this.saveRam[address - this.saveBase];
    return this.rom[this.romAddress(address)];
  }

  read16(address: number): number {
    if (this.inSaveRam(address)) {
      const at = address - this.saveBase;
      return (this.saveRam[at] << 8) | (this.saveRam[at + 1] ?? 0xff);
    }
    const at = this.romAddress(address);
    return (this.rom[at] << 8) | this.rom[at + 1];
  }

  write8(address: number, value: number): void {
    if (!this.inSaveRam(address) || this.saveRamControl & 2) return;
    const at = address - this.saveBase;
    if (this.saveRam[at] !== value) this.batteryDirty = true;
    this.saveRam[at] = value;
    this.saveUsed = true;
  }

  write16(address: number, value: number): void {
    this.write8(address, value >> 8);
    if (address + 1 <= this.saveEnd) this.write8(address + 1, value & 0xff);
  }

  /** Writes to $A130F1-$A130FF: the save RAM switch and the bank registers. */
  writeRegister(address: number, value: number): void {
    const reg = address & 0xff;
    if (reg === 0xf1) this.saveRamControl = value & 3;
    else if (this.banked && reg >= 0xf3 && reg & 1) this.banks[(reg - 0xf1) >> 1] = value & 0x3f;
  }
}
