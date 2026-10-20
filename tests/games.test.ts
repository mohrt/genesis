import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { detectRom } from '../src/cart/detect';
import { Genesis } from '../src/genesis';
import { Button } from '../src/io/controllers';
import { framePng } from './helpers/png';

// Cartridge images are never committed. These run the free games (`npm run fetch:games`
// puts them in public/games/) and any of your own you put in roms/.
const root = join(import.meta.dirname, '..');
const EXTENSIONS = /\.(md|bin|gen|smd)$/i;
const romFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => EXTENSIONS.test(name)).map((name) => join(dir, name)) : [];
const cartridges = [...romFiles(join(root, 'public', 'games')), ...romFiles(join(root, 'roms'))];
/** Set SHOTS=<dir> to save screenshots of the title screen and after pressing buttons. */
const shotsDir = process.env.SHOTS;
const FPS = 60;
const TITLE_SECONDS = 5;
const PLAY_SECONDS = 10;

/** A console set up for a ROM file as the page would (Auto for everything). */
export function machineFor(path: string): Genesis {
  const info = detectRom(new Uint8Array(readFileSync(path)), path);
  const machine = new Genesis();
  machine.setRegion(info.region ?? 'export');
  machine.setTv(info.tv ?? 'ntsc');
  machine.insertCartridge(new Cartridge(info.rom, info.saveRam));
  return machine;
}

describe.skipIf(cartridges.length === 0)('cartridges', () => {
  for (const path of cartridges) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(EXTENSIONS, '');
    it(`${name} boots, draws a picture and keeps running`, () => {
      const machine = machineFor(path);
      const pad = machine.controllers.inputs[0];
      const shot = (label: string) => {
        if (!shotsDir) return;
        mkdirSync(shotsDir, { recursive: true });
        writeFileSync(join(shotsDir, `${name} - ${label}.png`), framePng(machine));
      };
      for (let frame = 0; frame < TITLE_SECONDS * FPS; frame++) machine.runFrame();
      shot('title');
      const shown = machine.vdp.framebuffer.subarray(0, 320 * machine.vdp.frameLines);
      expect(new Set(shown).size, 'colours on the title screen').toBeGreaterThan(1);
      // Press Start, then A, a few times each, as a player would, then let it run.
      for (let frame = 0; frame < PLAY_SECONDS * FPS; frame++) {
        const pressing = frame % 60 < 5 && frame < 4 * FPS;
        pad.set('test', { buttons: pressing ? (frame % 120 < 60 ? Button.Start : Button.A) : 0 });
        machine.runFrame();
      }
      shot('later');
      expect(machine.vdp.frames).toBeGreaterThanOrEqual((TITLE_SECONDS + PLAY_SECONDS) * FPS);
    }, 120_000);
  }
});
