import { deflateSync } from 'node:zlib';
import type { Genesis } from '../../src/genesis';
import { crc32 } from '../../src/util/crc32';
import { MAX_WIDTH, SHADE_HIGHLIGHT, SHADE_SHADOW } from '../../src/vdp/vdp';

const NORMAL = [0, 52, 87, 116, 144, 172, 206, 255];
const SHADOW = [0, 29, 52, 70, 87, 101, 116, 130];
const HIGHLIGHT = [130, 144, 158, 172, 187, 206, 228, 255];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes the machine's last picture as an RGB PNG, 320 wide (256-pixel lines stretched) and each line drawn twice. */
export function framePng(machine: Genesis): Uint8Array {
  const { framebuffer, lineWidths } = machine.vdp;
  const lines = machine.vdp.frameLines;
  const doubled = lines <= 240;
  const width = MAX_WIDTH;
  const height = doubled ? lines * 2 : lines;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const line = doubled ? y >> 1 : y;
    const lineWidth = lineWidths[line] || MAX_WIDTH;
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const value = framebuffer[line * MAX_WIDTH + Math.floor((x * lineWidth) / MAX_WIDTH)];
      const levels = value & SHADE_HIGHLIGHT ? HIGHLIGHT : value & SHADE_SHADOW ? SHADOW : NORMAL;
      raw.set([levels[value & 7], levels[(value >> 3) & 7], levels[(value >> 6) & 7]], row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
