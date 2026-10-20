import { MAX_WIDTH, SHADE_HIGHLIGHT, SHADE_SHADOW } from '../vdp/vdp';

/**
 * The console's colour levels for each 3-bit component, normal, in shadow and
 * highlighted, as measured from its video output (not evenly spaced).
 */
const LEVELS = {
  normal: [0, 52, 87, 116, 144, 172, 206, 255],
  shadow: [0, 29, 52, 70, 87, 101, 116, 130],
  highlight: [130, 144, 158, 172, 187, 206, 228, 255],
};

/** Framebuffer values (9-bit colour with the shade above) as canvas pixels (little-endian RGBA). */
const RGBA = Uint32Array.from({ length: 0x800 }, (_, value) => {
  const levels = value & SHADE_HIGHLIGHT ? LEVELS.highlight : value & SHADE_SHADOW ? LEVELS.shadow : LEVELS.normal;
  const r = levels[value & 7];
  const g = levels[(value >> 3) & 7];
  const b = levels[(value >> 6) & 7];
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

/** H40's 320 pixels fill the same width of a TV picture as H32's 256 (whose pixels are 8:7). */
const H40_PIXEL_ASPECT = 32 / 35;
/** The picture is 224 lines tall on screen, however it is made (240 on PAL in V30, 448 interlaced). */
const BASE_LINES = 224;

/** Turns finished frames into canvas pixels: 320 wide (256-pixel lines are stretched to match), 224 to 480 tall. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image!: ImageData;
  private pixels!: Uint32Array;
  private width = MAX_WIDTH;
  private height = BASE_LINES;
  private hasNewFrame = false;
  /** Called with the width / height ratio the canvas should be shown at, whenever it changes. */
  onAspect: (aspect: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.resize(MAX_WIDTH, BASE_LINES);
  }

  get aspect(): number {
    const lines = this.height > 240 ? this.height / 2 : this.height;
    return (MAX_WIDTH * H40_PIXEL_ASPECT) / lines;
  }

  private resize(width: number, height: number): void {
    if (this.image && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.image = this.context.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.hasNewFrame = true;
    this.onAspect(this.aspect);
  }

  /** Copies a finished frame to the canvas's pixels. Each line is 256 or 320 wide in the frame. */
  capture(frame: Uint16Array, lineWidths: Uint16Array, lines: number): void {
    this.resize(MAX_WIDTH, lines);
    const { pixels } = this;
    let i = 0;
    for (let row = 0; row < lines; row++) {
      const start = row * MAX_WIDTH;
      const width = lineWidths[row] || MAX_WIDTH;
      if (width === MAX_WIDTH) {
        for (let x = 0; x < MAX_WIDTH; x++) pixels[i++] = RGBA[frame[start + x] & 0x7ff];
      } else {
        for (let x = 0; x < MAX_WIDTH; x++) pixels[i++] = RGBA[frame[start + Math.floor((x * width) / MAX_WIDTH)] & 0x7ff];
      }
    }
    this.hasNewFrame = true;
  }

  /** A dark screen with a faint scanline pattern, shown while no cartridge is in. */
  showIdle(): void {
    this.resize(MAX_WIDTH, BASE_LINES);
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / MAX_WIDTH) & 1 ? 0xff141414 : 0xff1c1c1c;
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
