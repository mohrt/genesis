/** The widest picture (H40 mode). */
export const MAX_WIDTH = 320;
/** The tallest picture: 240 lines, doubled in interlace mode 2. */
export const MAX_LINES = 480;
/** Framebuffer pixels are 9-bit colours (red in the low 3 bits) with the shade above them. */
export const SHADE_SHADOW = 0x200;
export const SHADE_HIGHLIGHT = 0x400;

/** Lines per frame. */
export const LINES_NTSC = 262;
export const LINES_PAL = 313;

const STATUS_FIXED = 0x3400;
const STATUS_FIFO_EMPTY = 0x0200;
const STATUS_VINT = 0x0080;
const STATUS_SPRITE_OVERFLOW = 0x0040;
const STATUS_COLLISION = 0x0020;
const STATUS_ODD = 0x0010;
const STATUS_VBLANK = 0x0008;
const STATUS_HBLANK = 0x0004;
const STATUS_DMA = 0x0002;
const STATUS_PAL = 0x0001;

/** A pixel of a layer: bit 7 is its priority, bits 5-0 its palette and colour; colour 0 is transparent. */
const PRIORITY = 0x80;
const OPAQUE = 0x0f;
/** Palette 3's last two colours as sprite pixels are the shadow and highlight operators. */
const HIGHLIGHT_OPERATOR = 0x3e;
const SHADOW_OPERATOR = 0x3f;

/** 68000 → VDP DMA moves this many bytes a line with the display on (H40, H32), and in the blanking. */
const DMA_BYTES_ACTIVE = [16, 18];
const DMA_BYTES_BLANK = [167, 205];
/** 68000 cycles in a line (3420 master clocks / 7). */
const CPU_CYCLES_PER_LINE = 3420 / 7;

/** The H counter's values across a line: the picture and right border, then a jump into the blanking. */
const H_COUNTS = [
  { last: 0x93, jumpTo: 0xe9, total: 171 },
  { last: 0xb6, jumpTo: 0xe4, total: 210 },
];

/**
 * The Genesis video chip (Yamaha YM7101) in mode 5: two scrolling planes, a
 * window, 80 sprites (64 in H32) with per-line limits, masking and collision,
 * shadow and highlight, the scroll modes, interlace mode 2's double-height
 * picture, and DMA from 68000 memory, fills and copies. It draws a whole line
 * when the line starts, from the state at that moment, and raises the
 * vertical (level 6) and horizontal (level 4) interrupts.
 */
export class Vdp {
  readonly vram = new Uint8Array(0x10000);
  readonly cram = new Uint16Array(64);
  readonly vsram = new Uint16Array(40);
  readonly regs = new Uint8Array(32);
  /** Sprite Y positions, sizes and links, cached as they are written into the sprite table (as the chip does). */
  readonly spriteCache = new Uint8Array(80 * 4);
  readonly framebuffer = new Uint16Array(MAX_WIDTH * MAX_LINES);
  /** The width of each line of the last frame: 256 or 320. */
  readonly lineWidths = new Uint16Array(MAX_LINES);

  pal = false;
  /** The current line, from 0 at the top of the picture. */
  line = 0;
  /** Waiting for the second word of a command. */
  pending = false;
  code = 0;
  address = 0;
  /** A DMA fill waits for its data word. */
  fillPending = false;
  vintPending = false;
  hintPending = false;
  hintCounter = 0;
  spriteOverflow = false;
  spriteCollision = false;
  /** The previous line ran out of sprite dots, which lets an X = 0 sprite mask the next. */
  dotOverflow = false;
  oddFrame = false;
  inVblank = false;
  inHblank = false;
  /** Lines a fill or copy keeps the DMA busy flag set for. */
  dmaBusyLines = 0;
  /** The H counter latched when HV latching is on. */
  hvLatch = 0;
  frames = 0;

  private readonly planeA = new Uint8Array(MAX_WIDTH + 16);
  private readonly planeB = new Uint8Array(MAX_WIDTH + 16);
  private readonly spriteLine = new Uint8Array(MAX_WIDTH + 16);
  /** Packed colours for each CRAM entry. */
  private readonly palette = new Uint16Array(64);

  /** Reads a word of 68000 memory, for DMA. */
  dmaRead: (address: number) => number = () => 0;
  /** Called when the interrupt level asked of the 68000 changes. */
  onInterrupt: (level: number) => void = () => {};
  /** How many 68000 cycles into the current line the CPU is, for the H counter. */
  lineCycle: () => number = () => 0;

  reset(): void {
    this.vram.fill(0);
    this.cram.fill(0);
    this.vsram.fill(0);
    this.regs.fill(0);
    this.spriteCache.fill(0);
    this.palette.fill(0);
    this.pending = this.fillPending = false;
    this.code = this.address = 0;
    this.vintPending = this.hintPending = false;
    this.spriteOverflow = this.spriteCollision = this.dotOverflow = false;
    this.oddFrame = this.inVblank = this.inHblank = false;
    this.dmaBusyLines = 0;
    this.hintCounter = 0;
    this.line = this.totalLines - 1;
    this.updateInterrupts();
  }

  // --- Geometry -------------------------------------------------------------------

  get h40(): boolean {
    return (this.regs[12] & 0x01) !== 0;
  }

  get width(): number {
    return this.h40 ? 320 : 256;
  }

  /** 240 lines needs V30 mode, which only PAL consoles can show. */
  get activeLines(): number {
    return this.pal && this.regs[1] & 0x08 ? 240 : 224;
  }

  get totalLines(): number {
    return this.pal ? LINES_PAL : LINES_NTSC;
  }

  /** Interlace mode 2: a double-height picture with 8x16 tiles, alternate lines in alternate fields. */
  get doubleHeight(): boolean {
    return (this.regs[12] & 0x06) === 0x06;
  }

  get displayEnabled(): boolean {
    return (this.regs[1] & 0x40) !== 0;
  }

  /** The lines of the last frame (doubled in interlace mode 2). */
  get frameLines(): number {
    return this.doubleHeight ? this.activeLines * 2 : this.activeLines;
  }

  // --- Interrupts and timing ----------------------------------------------------------

  private updateInterrupts(): void {
    let level = 0;
    if (this.vintPending && this.regs[1] & 0x20) level = 6;
    else if (this.hintPending && this.regs[0] & 0x10) level = 4;
    this.onInterrupt(level);
  }

  /** The 68000 took the interrupt at `level`. */
  acknowledge(level: number): void {
    if (level === 6) this.vintPending = false;
    else if (level === 4) this.hintPending = false;
    this.updateInterrupts();
  }

  /**
   * Starts the next line: draws it if it is in the picture, and at the bottom
   * of the picture starts the vertical blanking and its interrupt. Returns
   * true when that line finishes a frame.
   */
  startLine(): boolean {
    this.line++;
    if (this.line >= this.totalLines) {
      this.line = 0;
      this.frames++;
      this.oddFrame = (this.regs[12] & 0x02) !== 0 ? !this.oddFrame : false;
    }
    this.inHblank = false;
    if (this.dmaBusyLines > 0) this.dmaBusyLines--;
    const active = this.activeLines;
    if (this.line === 0) this.inVblank = false;
    if (this.line < active) {
      this.renderLine(this.line);
      return false;
    }
    if (this.line === active) {
      this.inVblank = true;
      this.vintPending = true;
      this.updateInterrupts();
      return true;
    }
    return false;
  }

  /** The horizontal blanking starts: the line counter counts down through the picture and reloads below it. */
  startHblank(): void {
    this.inHblank = true;
    if (this.line <= this.activeLines) {
      if (--this.hintCounter < 0) {
        this.hintCounter = this.regs[10];
        this.hintPending = true;
        this.updateInterrupts();
      }
    } else {
      this.hintCounter = this.regs[10];
    }
  }

  private hCounter(): number {
    const counts = H_COUNTS[this.h40 ? 1 : 0];
    const position = Math.min(counts.total - 1, Math.floor((this.lineCycle() / CPU_CYCLES_PER_LINE) * counts.total));
    return position <= counts.last ? position : (counts.jumpTo + position - counts.last - 1) & 0xff;
  }

  private vCounter(): number {
    let jumpAt = 0xea;
    let jumpTo = 0xe5;
    if (this.pal) {
      [jumpAt, jumpTo] = this.activeLines === 240 ? [0x10a, 0xd2] : [0x102, 0xca];
    }
    const value = this.line <= jumpAt ? this.line : this.line - jumpAt - 1 + jumpTo;
    if (!this.doubleHeight) return value & 0xff;
    const doubled = (value << 1) | (this.oddFrame ? 1 : 0);
    return (doubled & 0xfe) | ((doubled >> 8) & 1);
  }

  /** The HV counter at $C00008: the V counter in the high byte, the H counter in the low. */
  readHv(): number {
    const h = this.regs[0] & 0x02 ? this.hvLatch : this.hCounter();
    return (this.vCounter() << 8) | h;
  }

  readStatus(): number {
    let value = STATUS_FIXED | STATUS_FIFO_EMPTY;
    if (this.vintPending) value |= STATUS_VINT;
    if (this.spriteOverflow) value |= STATUS_SPRITE_OVERFLOW;
    if (this.spriteCollision) value |= STATUS_COLLISION;
    if (this.oddFrame) value |= STATUS_ODD;
    if (this.inVblank || !this.displayEnabled) value |= STATUS_VBLANK;
    if (this.inHblank) value |= STATUS_HBLANK;
    if (this.dmaBusyLines > 0 || this.fillPending) value |= STATUS_DMA;
    if (this.pal) value |= STATUS_PAL;
    this.pending = false;
    this.spriteOverflow = this.spriteCollision = false;
    return value;
  }

  // --- Ports ------------------------------------------------------------------------

  /** Writes a word to the control port; returns the 68000 cycles a DMA from its memory holds it for. */
  writeControl(value: number): number {
    if (!this.pending) {
      if ((value & 0xc000) === 0x8000) {
        this.writeRegister((value >> 8) & 0x1f, value & 0xff);
        return 0;
      }
      this.code = (this.code & 0x3c) | (value >> 14);
      this.address = (this.address & 0xc000) | (value & 0x3fff);
      this.pending = true;
      return 0;
    }
    this.pending = false;
    this.code = (this.code & 0x03) | ((value >> 2) & 0x3c);
    this.address = (this.address & 0x3fff) | ((value & 0x03) << 14);
    if (!(this.code & 0x20) || !(this.regs[1] & 0x10)) return 0;
    const mode = this.regs[23] >> 6;
    if (mode < 2) return this.dmaFromMemory();
    if (mode === 2) {
      this.fillPending = true;
      return 0;
    }
    this.dmaCopy();
    return 0;
  }

  private writeRegister(reg: number, value: number): void {
    if (reg >= 24) return;
    const wasHblankLatch = this.regs[0] & 0x02;
    this.regs[reg] = value;
    if (reg === 0 && !wasHblankLatch && value & 0x02) this.hvLatch = this.hCounter();
    if (reg === 0 || reg === 1) this.updateInterrupts();
  }

  writeData(value: number): void {
    this.pending = false;
    if (this.fillPending) {
      this.dmaFill(value);
      return;
    }
    this.writeTarget(value);
    this.address = (this.address + this.regs[15]) & 0xffff;
  }

  /** Writes a word where the current command points: VRAM, CRAM or VSRAM. */
  private writeTarget(value: number): void {
    switch (this.code & 0x0f) {
      case 0x01:
        this.writeVram(this.address, value);
        break;
      case 0x03:
        this.writeCram((this.address >> 1) & 0x3f, value);
        break;
      case 0x05: {
        const index = (this.address >> 1) & 0x3f;
        if (index < this.vsram.length) this.vsram[index] = value & 0x7ff;
        break;
      }
    }
  }

  readData(): number {
    this.pending = false;
    let value = 0;
    switch (this.code & 0x0f) {
      case 0x00:
        value = (this.vram[this.address & 0xfffe] << 8) | this.vram[this.address | 1];
        break;
      case 0x04: {
        const index = (this.address >> 1) & 0x3f;
        value = index < this.vsram.length ? this.vsram[index] : 0;
        break;
      }
      case 0x08:
        value = this.cram[(this.address >> 1) & 0x3f];
        break;
      case 0x0c:
        value = this.vram[this.address ^ 1];
        break;
    }
    this.address = (this.address + this.regs[15]) & 0xffff;
    return value;
  }

  /** A word written at an odd address goes in with its bytes swapped. */
  private writeVram(address: number, value: number): void {
    if (address & 1) value = ((value & 0xff) << 8) | (value >> 8);
    const at = address & 0xfffe;
    this.vram[at] = value >> 8;
    this.vram[at + 1] = value & 0xff;
    this.cacheSprite(at, value >> 8);
    this.cacheSprite(at + 1, value & 0xff);
  }

  private writeVramByte(address: number, value: number): void {
    this.vram[address] = value;
    this.cacheSprite(address, value);
  }

  private cacheSprite(address: number, value: number): void {
    const offset = (address - this.spriteTable) & 0xffff;
    if (offset < 80 * 8 && (offset & 7) < 4) this.spriteCache[((offset >> 3) << 2) | (offset & 3)] = value;
  }

  private writeCram(index: number, value: number): void {
    this.cram[index] = value & 0x0eee;
    this.palette[index] = ((value >> 1) & 0x007) | ((value >> 2) & 0x038) | ((value >> 3) & 0x1c0);
  }

  private get spriteTable(): number {
    return this.h40 ? (this.regs[5] & 0x7e) << 9 : (this.regs[5] & 0x7f) << 9;
  }

  // --- DMA ----------------------------------------------------------------------------

  private get dmaLength(): number {
    return ((this.regs[20] << 8) | this.regs[19]) || 0x10000;
  }

  private finishDma(): void {
    this.regs[19] = this.regs[20] = 0;
    this.code &= ~0x20;
  }

  /** How many lines moving `bytes` takes at the chip's current bandwidth. */
  private dmaLines(bytes: number): number {
    const mode = this.h40 ? 1 : 0;
    const blank = this.inVblank || !this.displayEnabled;
    return bytes / (blank ? DMA_BYTES_BLANK[mode] : DMA_BYTES_ACTIVE[mode]);
  }

  /** 68000 memory to VRAM, CRAM or VSRAM. The source counts within a 128K window. */
  private dmaFromMemory(): number {
    const length = this.dmaLength;
    const high = (this.regs[23] & 0x7f) << 17;
    let source = (this.regs[22] << 9) | (this.regs[21] << 1);
    for (let i = 0; i < length; i++) {
      this.writeTarget(this.dmaRead(high | source));
      source = (source + 2) & 0x1ffff;
      this.address = (this.address + this.regs[15]) & 0xffff;
    }
    this.regs[21] = (source >> 1) & 0xff;
    this.regs[22] = (source >> 9) & 0xff;
    this.finishDma();
    return Math.round(this.dmaLines(length * 2) * CPU_CYCLES_PER_LINE);
  }

  /** The data word is written, then its high byte fills the rest. */
  private dmaFill(value: number): void {
    this.fillPending = false;
    const length = this.dmaLength;
    const target = this.code & 0x0f;
    this.writeTarget(value);
    for (let i = 0; i < length; i++) {
      if (target === 0x01) this.writeVramByte(this.address ^ 1, value >> 8);
      else this.writeTarget(value);
      this.address = (this.address + this.regs[15]) & 0xffff;
    }
    this.finishDma();
    this.dmaBusyLines = Math.ceil(this.dmaLines(length));
  }

  /** VRAM to VRAM, a byte at a time. */
  private dmaCopy(): void {
    const length = this.dmaLength;
    let source = (this.regs[22] << 8) | this.regs[21];
    for (let i = 0; i < length; i++) {
      this.writeVramByte(this.address, this.vram[source]);
      source = (source + 1) & 0xffff;
      this.address = (this.address + this.regs[15]) & 0xffff;
    }
    this.regs[21] = source & 0xff;
    this.regs[22] = source >> 8;
    this.finishDma();
    this.dmaBusyLines = Math.ceil(this.dmaLines(length * 2));
  }

  // --- Drawing ------------------------------------------------------------------------

  private renderLine(line: number): void {
    const width = this.width;
    const double = this.doubleHeight;
    const row = double ? line * 2 + (this.oddFrame ? 1 : 0) : line;
    const out = row * MAX_WIDTH;
    this.lineWidths[row] = width;
    const background = this.palette[this.regs[7] & 0x3f];
    if (!this.displayEnabled || !(this.regs[1] & 0x04)) {
      this.framebuffer.fill(background, out, out + width);
      return;
    }
    const y = double ? row : line;
    this.renderPlane(this.planeB, (this.regs[4] & 0x07) << 13, 1, line, y, width);
    this.renderPlaneAndWindow(line, y, width);
    this.renderSprites(y, width);
    this.compose(out, width);
  }

  /** The plane's size in cells; the chip can't address more than 4K cells (128x32, 64x64). */
  private planeSize(): [number, number] {
    const sizes = [32, 64, 32, 128];
    const w = sizes[this.regs[16] & 3];
    let h = sizes[(this.regs[16] >> 4) & 3];
    if (w === 128) h = 32;
    else if (w === 64 && h === 128) h = 64;
    return [w, h];
  }

  /** The horizontal scroll of plane A (`plane` 0) or B (1) for a line. */
  private hScroll(plane: number, line: number): number {
    const base = (this.regs[13] & 0x3f) << 10;
    let index = 0;
    switch (this.regs[11] & 3) {
      case 1:
        index = line & 7;
        break;
      case 2:
        index = line & ~7;
        break;
      case 3:
        index = line;
        break;
    }
    const at = (base + index * 4 + plane * 2) & 0xffff;
    return ((this.vram[at] << 8) | this.vram[at + 1]) & 0x3ff;
  }

  /** The vertical scroll of a plane for a 16-pixel column (or the whole screen). */
  private vScroll(plane: number, column: number): number {
    const index = this.regs[11] & 0x04 ? Math.min(column, 19) * 2 + plane : plane;
    return this.vsram[index] & (this.doubleHeight ? 0x7ff : 0x3ff);
  }

  /**
   * Draws a scrolling plane's line into `target`, from `startX` to `endX`.
   * `y` is the line within the picture (doubled in interlace mode 2).
   */
  private renderPlane(target: Uint8Array, base: number, plane: number, line: number, y: number, endX: number, startX = 0): void {
    const [cellsW, cellsH] = this.planeSize();
    const double = this.doubleHeight;
    const tileHeight = double ? 16 : 8;
    const widthMask = cellsW * 8 - 1;
    const heightMask = cellsH * tileHeight - 1;
    const scrollX = this.hScroll(plane, line);
    const vram = this.vram;
    let x = startX;
    while (x < endX) {
      const px = (x - scrollX) & widthMask;
      const py = (y + this.vScroll(plane, x >> 4)) & heightMask;
      const entryAt = (base + ((Math.floor(py / tileHeight) * cellsW + (px >> 3)) << 1)) & 0xffff;
      const entry = (vram[entryAt] << 8) | vram[entryAt + 1];
      const fine = px & 7;
      const count = Math.min(8 - fine, endX - x);
      this.drawTileRow(target, x, entry, py % tileHeight, fine, count);
      x += count;
    }
  }

  /** Draws `count` pixels of a tile's row from column `fine`, for a plane or the window. */
  private drawTileRow(target: Uint8Array, x: number, entry: number, tileRow: number, fine: number, count: number): void {
    const double = this.doubleHeight;
    const tileHeight = double ? 16 : 8;
    const row = entry & 0x1000 ? tileHeight - 1 - tileRow : tileRow;
    const tile = entry & 0x7ff;
    const rowAt = double ? ((tile << 6) + (row << 2)) & 0xffff : ((tile << 5) + (row << 2)) & 0xffff;
    const attributes = ((entry >> 15) << 7) | ((entry >> 9) & 0x30);
    const flip = (entry & 0x0800) !== 0;
    const vram = this.vram;
    for (let i = 0; i < count; i++) {
      const column = flip ? 7 - (fine + i) : fine + i;
      const byte = vram[rowAt + (column >> 1)];
      const pixel = column & 1 ? byte & 0x0f : byte >> 4;
      target[x + i] = pixel ? attributes | pixel : attributes & PRIORITY;
    }
  }

  /** Plane A, with the window in its place where the window registers put it. */
  private renderPlaneAndWindow(line: number, y: number, width: number): void {
    const h40 = this.h40;
    const windowBase = h40 ? (this.regs[3] & 0x3c) << 10 : (this.regs[3] & 0x3e) << 10;
    const planeABase = (this.regs[2] & 0x38) << 10;
    const cellLines = this.doubleHeight ? 16 : 8;
    const splitY = (this.regs[18] & 0x1f) * 8;
    const inWindowRows = this.regs[18] & 0x80 ? line >= splitY : line < splitY;
    let windowStart = 0;
    let windowEnd = width;
    if (!inWindowRows) {
      const splitX = Math.min(width, (this.regs[17] & 0x1f) * 16);
      if (this.regs[17] & 0x80) windowStart = splitX;
      else windowEnd = splitX;
    }
    if (windowStart > 0) this.renderPlane(this.planeA, planeABase, 0, line, y, windowStart);
    if (windowEnd < width) this.renderPlane(this.planeA, planeABase, 0, line, y, width, windowEnd);
    if (windowEnd <= windowStart) return;
    const cellsW = h40 ? 64 : 32;
    const tileY = Math.floor(y / cellLines);
    for (let x = windowStart; x < windowEnd; x += 8) {
      const entryAt = (windowBase + ((tileY * cellsW + (x >> 3)) << 1)) & 0xffff;
      const entry = (this.vram[entryAt] << 8) | this.vram[entryAt + 1];
      this.drawTileRow(this.planeA, x, entry, y % cellLines, 0, Math.min(8, windowEnd - x));
    }
  }

  /**
   * Finds the sprites on the line by following the links from sprite 0, and
   * draws them front to back. Each line has room for 20 sprites and 320 dots
   * (16 and 256 in H32). A sprite at X = 0 hides the rest of the line's
   * sprites once another sprite has been seen on it.
   */
  private renderSprites(y: number, width: number): void {
    const buffer = this.spriteLine;
    buffer.fill(0, 0, width);
    const h40 = this.h40;
    const double = this.doubleHeight;
    const maxSprites = h40 ? 80 : 64;
    const perLine = h40 ? 20 : 16;
    const maxDots = h40 ? 320 : 256;
    const cellLines = double ? 16 : 8;
    const table = this.spriteTable;
    const cache = this.spriteCache;
    const vram = this.vram;
    let index = 0;
    let visited = 0;
    let onLine = 0;
    let dots = 0;
    let masked = false;
    const maskByPrevious = this.dotOverflow;
    this.dotOverflow = false;
    do {
      const cached = index << 2;
      const top = (((cache[cached] << 8) | cache[cached + 1]) & (double ? 0x3ff : 0x1ff)) - (double ? 256 : 128);
      const size = cache[cached + 2];
      const link = cache[cached + 3] & 0x7f;
      const cellsW = ((size >> 2) & 3) + 1;
      const cellsH = (size & 3) + 1;
      const rowInSprite = y - top;
      if (rowInSprite >= 0 && rowInSprite < cellsH * cellLines) {
        if (++onLine > perLine) {
          this.spriteOverflow = true;
          break;
        }
        const at = (table + index * 8) & 0xffff;
        const attributes = (vram[at + 4] << 8) | vram[at + 5];
        const xPosition = ((vram[at + 6] << 8) | vram[at + 7]) & 0x1ff;
        if (xPosition === 0 && (onLine > 1 || maskByPrevious)) masked = true;
        const row = attributes & 0x1000 ? cellsH * cellLines - 1 - rowInSprite : rowInSprite;
        const flip = (attributes & 0x0800) !== 0;
        const left = xPosition - 128;
        const priority = ((attributes >> 15) << 7) | ((attributes >> 9) & 0x30);
        for (let cell = 0; cell < cellsW; cell++) {
          dots += 8;
          if (!masked) {
            const tile = ((attributes & 0x7ff) + (flip ? cellsW - 1 - cell : cell) * cellsH + Math.floor(row / cellLines)) & 0x7ff;
            const rowAt = double ? (tile << 6) + ((row & 15) << 2) : (tile << 5) + ((row & 7) << 2);
            this.drawSpriteCell(buffer, left + cell * 8, rowAt & 0xffff, flip, priority, width);
          }
          if (dots >= maxDots) break;
        }
        if (dots >= maxDots) {
          this.spriteOverflow = true;
          this.dotOverflow = true;
          break;
        }
      }
      index = link;
    } while (index !== 0 && ++visited < maxSprites);
  }

  private drawSpriteCell(buffer: Uint8Array, x: number, rowAt: number, flip: boolean, attributes: number, width: number): void {
    const vram = this.vram;
    for (let i = 0; i < 8; i++) {
      const screenX = x + i;
      if (screenX < 0 || screenX >= width) continue;
      const column = flip ? 7 - i : i;
      const byte = vram[rowAt + (column >> 1)];
      const pixel = column & 1 ? byte & 0x0f : byte >> 4;
      if (!pixel) continue;
      // Sprites earlier in the list are in front; a second sprite pixel on top of one is a collision.
      if (buffer[screenX] & OPAQUE) {
        this.spriteCollision = true;
        continue;
      }
      buffer[screenX] = attributes | pixel;
    }
  }

  /**
   * Puts the layers together: high-priority sprites, plane A and plane B in
   * front of the low-priority ones, then the background colour. With shadow
   * and highlight on, low-priority pixels are darkened, and palette 3's last
   * two colours in sprites lighten or darken what is under them.
   */
  private compose(out: number, width: number): void {
    const { planeA, planeB, spriteLine, palette, framebuffer } = this;
    const backgroundIndex = this.regs[7] & 0x3f;
    const shadowHighlight = (this.regs[12] & 0x08) !== 0;
    const blankLeft = (this.regs[0] & 0x20) !== 0;
    for (let x = 0; x < width; x++) {
      if (blankLeft && x < 8) {
        framebuffer[out + x] = palette[backgroundIndex];
        continue;
      }
      const a = planeA[x];
      const b = planeB[x];
      const s = spriteLine[x];
      const below = planePixel(a, b, backgroundIndex);
      let pixel: number;
      const spriteInFront = (s & OPAQUE) !== 0 && (s & PRIORITY || !(((a & OPAQUE) !== 0 && a & PRIORITY) || ((b & OPAQUE) !== 0 && b & PRIORITY)));
      pixel = spriteInFront ? s : below;
      if (!shadowHighlight) {
        framebuffer[out + x] = palette[pixel & 0x3f];
        continue;
      }
      let shade = (a | b) & PRIORITY ? 0 : SHADE_SHADOW;
      if (spriteInFront) {
        const color = s & 0x3f;
        if (color === HIGHLIGHT_OPERATOR) {
          pixel = below;
          shade = shade ? 0 : SHADE_HIGHLIGHT;
        } else if (color === SHADOW_OPERATOR) {
          pixel = below;
          shade = SHADE_SHADOW;
        } else if (s & PRIORITY || (color & 0x0f) === 0x0e) {
          shade = 0;
        }
      }
      framebuffer[out + x] = palette[pixel & 0x3f] | shade;
    }
  }
}

/** The front pixel of the two planes (high priority first, then A before B), or the background colour. */
function planePixel(a: number, b: number, background: number): number {
  const aOpaque = (a & OPAQUE) !== 0;
  const bOpaque = (b & OPAQUE) !== 0;
  if (aOpaque && a & PRIORITY) return a;
  if (bOpaque && b & PRIORITY) return b;
  if (aOpaque) return a;
  if (bOpaque) return b;
  return background;
}
