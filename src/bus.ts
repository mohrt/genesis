import type { Cartridge } from './cart/cartridge';
import type { Region } from './cart/detect';
import type { M68kBus } from './cpu/m68k';
import type { Z80Bus } from './cpu/z80';
import type { Controllers } from './io/controllers';
import type { Sn76489 } from './sound/sn76489';
import type { Ym2612 } from './sound/ym2612';
import type { Vdp } from './vdp/vdp';

const RAM_SIZE = 0x10000;
const Z80_RAM_SIZE = 0x2000;
/** The TMSS boot ROM is 2K, repeated through the cartridge's space while it is switched in. */
const BOOT_ROM_SIZE = 0x800;
/** Version register bit 5: no expansion unit (Sega CD) is connected. */
const NO_EXPANSION = 0x20;

/**
 * The 68000's memory map and the Z80's.
 *
 * 68000: the cartridge at $000000-$3FFFFF (or the TMSS boot ROM, until it
 * switches the cartridge in); the Z80's space at $A00000 (its RAM, the
 * YM2612 and its bank register) while the 68000 holds the Z80's bus; the
 * version register and controller ports at $A10000; the Z80's bus request
 * and reset at $A11100 and $A11200; the cartridge's registers at $A130F1;
 * the VDP (with the PSG in it) at $C00000; 64K of RAM at $E00000-$FFFFFF.
 *
 * Z80: 8K of RAM at $0000 (repeated at $2000), the YM2612 at $4000, the bank
 * register at $6000 (written a bit at a time), the VDP at $7F00, and a 32K
 * window into the 68000's space at $8000.
 */
export class GenesisBus implements M68kBus {
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly z80Ram = new Uint8Array(Z80_RAM_SIZE);
  cartridge: Cartridge | null = null;
  /** The player's TMSS boot ROM, or null to start games directly. */
  bootRom: Uint8Array | null = null;
  bootRomMapped = false;
  region: Region = 'export';
  pal = false;
  /** The 68000 has asked for the Z80's bus (the Z80 stops). */
  z80BusRequested = false;
  /** The Z80 (and the YM2612) are held in reset. */
  z80Reset = true;
  /** Bits 23-15 of the 68000 address the Z80's window at $8000 shows. */
  z80Bank = 0;
  /** 68000 cycles a DMA has held the CPU for, to be added to its time. */
  stall = 0;
  /** The 68000's time in cycles, for the six-button pad's timeout. */
  now: () => number = () => 0;
  /** Called when the Z80's reset line is released, so it starts again from 0. */
  onZ80Reset: () => void = () => {};
  /** Called before a sound chip is written, to bring its output up to the moment of the write. */
  beforeSound: () => void = () => {};

  constructor(
    private readonly vdp: Vdp,
    private readonly psg: Sn76489,
    private readonly ym: Ym2612,
    private readonly controllers: Controllers,
  ) {}

  reset(): void {
    this.z80BusRequested = false;
    this.z80Reset = true;
    this.z80Bank = 0;
    this.bootRomMapped = this.bootRom !== null;
    this.stall = 0;
  }

  /** The 68000 can reach the Z80's space while the Z80 is stopped for it. */
  get z80Running(): boolean {
    return !this.z80Reset && !this.z80BusRequested;
  }

  acknowledgeInterrupt(level: number): void {
    this.vdp.acknowledge(level);
  }

  resetDevices(): void {}

  // --- 68000 side -------------------------------------------------------------------

  read16(address: number): number {
    if (address < 0x400000) {
      if (this.bootRomMapped && this.bootRom) {
        const at = address & (BOOT_ROM_SIZE - 1);
        return (this.bootRom[at] << 8) | this.bootRom[at + 1];
      }
      return this.cartridge ? this.cartridge.read16(address) : 0xffff;
    }
    if (address >= 0xe00000) {
      const at = address & 0xffff;
      return (this.ram[at] << 8) | this.ram[at + 1];
    }
    if (address >= 0xc00000) return this.readVdp(address);
    if (address < 0xa10000) {
      const value = this.readZ80Space(address & 0xfffe);
      return (value << 8) | value;
    }
    if (address < 0xa10020) {
      const value = this.readIo(address | 1);
      return (value << 8) | value;
    }
    if ((address & 0xffff00) === 0xa11100) return this.z80BusGranted ? 0 : 0x0100;
    return 0;
  }

  read8(address: number): number {
    if (address < 0x400000) {
      if (this.bootRomMapped && this.bootRom) return this.bootRom[address & (BOOT_ROM_SIZE - 1)];
      return this.cartridge ? this.cartridge.read8(address) : 0xff;
    }
    if (address >= 0xe00000) return this.ram[address & 0xffff];
    if (address >= 0xc00000) {
      const word = this.readVdp(address & ~1);
      return address & 1 ? word & 0xff : word >> 8;
    }
    if (address < 0xa10000) return this.readZ80Space(address);
    if (address < 0xa10020) return this.readIo(address);
    if (address === 0xa11100) return this.z80BusGranted ? 0 : 1;
    return 0;
  }

  write16(address: number, value: number): void {
    if (address >= 0xe00000) {
      const at = address & 0xffff;
      this.ram[at] = value >> 8;
      this.ram[at + 1] = value & 0xff;
      return;
    }
    if (address < 0x400000) {
      this.cartridge?.write16(address, value);
      return;
    }
    if (address >= 0xc00000) {
      this.writeVdp(address, value);
      return;
    }
    // The Z80's space and the I/O chip are 8 bits wide: a word write lands as its high byte.
    if (address < 0xa10000) {
      this.writeZ80Space(address, value >> 8);
      return;
    }
    if (address < 0xa10020) {
      this.writeIo(address | 1, value & 0xff);
      return;
    }
    this.writeControl(address, value >> 8, value & 0xff);
  }

  write8(address: number, value: number): void {
    if (address >= 0xe00000) {
      this.ram[address & 0xffff] = value;
      return;
    }
    if (address < 0x400000) {
      this.cartridge?.write8(address, value);
      return;
    }
    if (address >= 0xc00000) {
      // A byte written to the VDP's ports arrives as the same byte in both halves of a word.
      if ((address & 0x1f) >= 0x10) this.writeVdp(address, value);
      else this.writeVdp(address & ~1, (value << 8) | value);
      return;
    }
    if (address < 0xa10000) {
      this.writeZ80Space(address, value);
      return;
    }
    if (address < 0xa10020) {
      this.writeIo(address, value);
      return;
    }
    if (address & 1) this.writeControl(address & ~1, 0, value);
    else this.writeControl(address, value, 0);
  }

  /** The bus request is granted once the Z80 has stopped (and it can't be while it is held in reset). */
  private get z80BusGranted(): boolean {
    return this.z80BusRequested && !this.z80Reset;
  }

  /** $A11100 (bus request), $A11200 (Z80 reset), $A130F1-$A130FF (cartridge), $A14101 (TMSS). */
  private writeControl(address: number, high: number, low: number): void {
    if ((address & 0xffff00) === 0xa11100) {
      this.z80BusRequested = (high & 1) !== 0;
    } else if ((address & 0xffff00) === 0xa11200) {
      const reset = !(high & 1);
      if (this.z80Reset && !reset) this.onZ80Reset();
      if (reset) {
        this.beforeSound();
        this.ym.reset();
      }
      this.z80Reset = reset;
    } else if ((address & 0xffff00) === 0xa13000) {
      this.cartridge?.writeRegister(address | 1, low);
    } else if (address === 0xa14100) {
      this.bootRomMapped = this.bootRom !== null && !(low & 1);
    }
  }

  private readVdp(address: number): number {
    const port = address & 0x1e;
    if (port < 0x04) return this.vdp.readData();
    if (port < 0x08) return this.vdp.readStatus();
    if (port < 0x10) return this.vdp.readHv();
    return 0xffff;
  }

  private writeVdp(address: number, value: number): void {
    const port = address & 0x1f;
    if (port < 0x04) this.vdp.writeData(value);
    else if (port < 0x08) this.stall += this.vdp.writeControl(value);
    else if (port >= 0x10 && port < 0x18) {
      this.beforeSound();
      this.psg.write(value & 0xff);
    }
  }

  /** The version register and the three ports' data and control registers. Serial ports read as idle. */
  private readIo(address: number): number {
    switch (address & 0x1f) {
      case 0x01: {
        let version = NO_EXPANSION | (this.bootRom ? 1 : 0);
        if (this.region === 'export') version |= 0x80;
        if (this.pal) version |= 0x40;
        return version;
      }
      case 0x03:
        return this.controllers.read(0, this.now());
      case 0x05:
        return this.controllers.read(1, this.now());
      case 0x07:
        return 0x7f;
      case 0x09:
        return this.controllers.ports[0].control;
      case 0x0b:
        return this.controllers.ports[1].control;
      case 0x0f:
      case 0x15:
      case 0x1b:
        return 0xff;
      default:
        return 0;
    }
  }

  private writeIo(address: number, value: number): void {
    const now = this.now();
    switch (address & 0x1f) {
      case 0x03:
        this.controllers.ports[0].writeData(value, now);
        break;
      case 0x05:
        this.controllers.ports[1].writeData(value, now);
        break;
      case 0x09:
        this.controllers.ports[0].writeControl(value, now);
        break;
      case 0x0b:
        this.controllers.ports[1].writeControl(value, now);
        break;
    }
  }

  /** The Z80's space as the 68000 sees it at $A00000. */
  private readZ80Space(address: number): number {
    const at = address & 0xffff;
    if (at < 0x4000) return this.z80Ram[at & (Z80_RAM_SIZE - 1)];
    if (at < 0x6000) return this.ym.readStatus();
    return 0xff;
  }

  private writeZ80Space(address: number, value: number): void {
    const at = address & 0xffff;
    if (at < 0x4000) this.z80Ram[at & (Z80_RAM_SIZE - 1)] = value;
    else if (at < 0x6000) this.writeYm(at, value);
    else if (at < 0x6100) this.writeBank(value);
    else if (at >= 0x7f00 && at < 0x7f20) this.writeVdp(0xc00000 | (at & 0x1f), (value << 8) | value);
  }

  private writeYm(address: number, value: number): void {
    this.beforeSound();
    this.ym.write(address & 3, value);
  }

  private writeBank(value: number): void {
    this.z80Bank = ((this.z80Bank >> 1) | ((value & 1) << 8)) & 0x1ff;
  }

  // --- Z80 side -----------------------------------------------------------------------

  /** The Z80's view, for its CPU. */
  readonly z80: Z80Bus = {
    read: (address) => {
      if (address < 0x4000) return this.z80Ram[address & (Z80_RAM_SIZE - 1)];
      if (address < 0x6000) return this.ym.readStatus();
      if (address < 0x7f00) return 0xff;
      if (address < 0x8000) {
        if (address >= 0x7f20) return 0xff;
        const word = this.readVdp(address & 0x1e);
        return address & 1 ? word & 0xff : word >> 8;
      }
      const target = (this.z80Bank << 15) | (address & 0x7fff);
      // The window can't reach the Z80's own space or the VDP without locking up a real console.
      if (target >= 0xa00000 && target < 0xe00000) return 0xff;
      return this.read8(target);
    },
    write: (address, value) => {
      if (address < 0x4000) {
        this.z80Ram[address & (Z80_RAM_SIZE - 1)] = value;
      } else if (address < 0x6000) {
        this.writeYm(address, value);
      } else if (address < 0x6100) {
        this.writeBank(value);
      } else if (address >= 0x7f00 && address < 0x7f20) {
        const port = address & 0x1f;
        if (port >= 0x10) this.writeVdp(0xc00000 | port, value);
        else this.writeVdp(0xc00000 | (port & ~1), (value << 8) | value);
      } else if (address >= 0x8000) {
        const target = (this.z80Bank << 15) | (address & 0x7fff);
        if (target < 0xa00000 || target >= 0xe00000) this.write8(target, value);
      }
    },
    input: () => 0xff,
    output: () => {},
  };
}
