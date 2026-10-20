/** Export consoles (USA, Europe) and Japanese ones read their region from the version register. */
export type Region = 'export' | 'japan';
export type TvSystem = 'ntsc' | 'pal';

export interface SaveRam {
  start: number;
  end: number;
}

/** What a cartridge image says about itself. */
export interface RomInfo {
  /** The ROM as the console sees it: big-endian words, with any copier header and interleaving undone. */
  rom: Uint8Array;
  /** The name in the header (the overseas one, or the Japanese one), or null. */
  title: string | null;
  /** "SEGA" at $100, as licensed (and most homebrew) games have. */
  hasHeader: boolean;
  /** From the file name if it says, otherwise from the regions the header lists; null if neither does. */
  region: Region | null;
  tv: TvSystem | null;
  /** The battery-backed RAM the header declares. */
  saveRam: SaveRam | null;
  /** Whether the file was in the Super Magic Drive's interleaved format. */
  interleaved: boolean;
}

const HEADER = 0x100;
const SMD_HEADER = 0x200;
const SMD_BLOCK = 0x4000;

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const hasSegaHeader = (rom: Uint8Array) => rom.length >= 0x200 && ascii(rom, HEADER, 4) === 'SEGA';

/** Super Magic Drive files: a 512-byte header, then 16K blocks of odd bytes followed by even bytes. */
function deinterleave(image: Uint8Array): Uint8Array {
  const body = image.subarray(SMD_HEADER);
  const rom = new Uint8Array(body.length);
  for (let block = 0; block < body.length; block += SMD_BLOCK) {
    const half = SMD_BLOCK / 2;
    for (let i = 0; i < half; i++) {
      rom[block + i * 2 + 1] = body[block + i];
      rom[block + i * 2] = body[block + half + i];
    }
  }
  return rom;
}

/** The ROM inside an image: as it is, without a copier header, or deinterleaved. */
function unpack(image: Uint8Array): { rom: Uint8Array; interleaved: boolean } {
  if (hasSegaHeader(image) || image.length % SMD_BLOCK !== SMD_HEADER) return { rom: image, interleaved: false };
  const stripped = image.subarray(SMD_HEADER);
  if (hasSegaHeader(stripped)) return { rom: stripped.slice(), interleaved: false };
  const deinterleaved = deinterleave(image);
  if (hasSegaHeader(deinterleaved) || (image[8] === 0xaa && image[9] === 0xbb)) return { rom: deinterleaved, interleaved: true };
  return { rom: image, interleaved: false };
}

/** Regions in GoodTools and No-Intro file names, e.g. "(USA)", "(Europe)", "(J)". */
function regionFromName(fileName: string): { region: Region; tv: TvSystem } | null {
  const name = fileName.toLowerCase();
  if (/\((usa|u|us|world|ue|ju|jue)\b|\(usa,/.test(name)) return { region: 'export', tv: 'ntsc' };
  if (/\((europe|e|eu|pal|uk|germany|france|spain|italy|sweden)\b/.test(name)) return { region: 'export', tv: 'pal' };
  if (/\((japan|j|jp|asia|korea|k|brazil|b)\b/.test(name)) return { region: name.includes('(brazil') || name.includes('(b)') ? 'export' : 'japan', tv: 'ntsc' };
  return null;
}

/**
 * The regions the header lists at $1F0: letters (J for Japan, U for the
 * Americas, E for Europe) in older games, or a hex digit of flags (1 Japan,
 * 4 Americas, 8 Europe) in later ones. An American console is preferred,
 * then a Japanese one, then a European one.
 */
function regionFromHeader(rom: Uint8Array): { region: Region; tv: TvSystem } | null {
  if (rom.length < 0x200) return null;
  const codes = ascii(rom, 0x1f0, 3).toUpperCase();
  let japan = codes.includes('J');
  let americas = codes.includes('U');
  let europe = codes.includes('E');
  if (!japan && !americas && !europe && /^[0-9A-F]/.test(codes)) {
    const flags = parseInt(codes[0], 16);
    japan = (flags & 1) !== 0;
    americas = (flags & 4) !== 0;
    europe = (flags & 8) !== 0;
  }
  if (americas) return { region: 'export', tv: 'ntsc' };
  if (japan) return { region: 'japan', tv: 'ntsc' };
  if (europe) return { region: 'export', tv: 'pal' };
  return null;
}

const long = (rom: Uint8Array, at: number) => ((rom[at] << 24) | (rom[at + 1] << 16) | (rom[at + 2] << 8) | rom[at + 3]) >>> 0;

/** The header's "RA" record at $1B0: where the battery-backed RAM sits. */
function saveRamFromHeader(rom: Uint8Array): SaveRam | null {
  if (rom.length < 0x1bc || rom[0x1b0] !== 0x52 || rom[0x1b1] !== 0x41) return null;
  const start = long(rom, 0x1b4) & 0xffffff;
  const end = long(rom, 0x1b8) & 0xffffff;
  if (end <= start || start < 0x200000 || end - start >= 0x100000) return null;
  return { start, end };
}

function titleFromHeader(rom: Uint8Array): string | null {
  if (!hasSegaHeader(rom)) return null;
  const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
  const overseas = clean(ascii(rom, 0x150, 48));
  const domestic = clean(ascii(rom, 0x120, 48));
  const title = overseas || domestic;
  return title ? title : null;
}

export function detectRom(image: Uint8Array, fileName = ''): RomInfo {
  const { rom, interleaved } = unpack(image);
  const fromName = regionFromName(fileName);
  const fromHeader = regionFromHeader(rom);
  const setting = fromName ?? fromHeader;
  return {
    rom,
    title: titleFromHeader(rom),
    hasHeader: hasSegaHeader(rom),
    region: setting?.region ?? null,
    tv: setting?.tv ?? null,
    saveRam: saveRamFromHeader(rom),
    interleaved,
  };
}
