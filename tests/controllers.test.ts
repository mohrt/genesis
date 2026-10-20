import { describe, expect, it } from 'vitest';
import { Button, Controllers } from '../src/io/controllers';

const TH_OUTPUT = 0x40;

/** Reads port 1 with TH driven high, then low, `pairs` times, as games do. */
function readPairs(controllers: Controllers, pairs: number, start = 0): number[] {
  const port = controllers.ports[0];
  port.writeData(0x40, start);
  port.writeControl(TH_OUTPUT, start);
  const values: number[] = [];
  let now = start;
  for (let i = 0; i < pairs; i++) {
    port.writeData(0x40, (now += 10));
    values.push(controllers.read(0, now) & 0x7f);
    port.writeData(0x00, (now += 10));
    values.push(controllers.read(0, now) & 0x7f);
  }
  return values;
}

describe('controllers', () => {
  it('reads the three-button pad through TH', () => {
    const controllers = new Controllers();
    controllers.padType = 'three';
    controllers.inputs[0].set('test', { buttons: Button.Up | Button.C | Button.A });
    const [high, low] = readPairs(controllers, 1);
    // TH high: ?1CBRLDU (0 = pressed); TH low: ?0SA00DU.
    expect(high).toBe(0b1011110);
    expect(low).toBe(0b0100010);
  });

  it('reads TH as high when it is an input', () => {
    const controllers = new Controllers();
    expect(controllers.read(0, 0) & 0x7f).toBe(0x7f);
  });

  it('reports X, Y, Z and Mode on the six-button pad on the fourth TH high', () => {
    const controllers = new Controllers();
    controllers.inputs[0].set('test', { buttons: Button.X | Button.Mode });
    const values = readPairs(controllers, 4, 100_000);
    // The third TH low reads all four direction bits low; the fourth high reads ?1CBMXYZ.
    expect(values[5] & 0x0f).toBe(0);
    expect(values[6]).toBe(0b1110011);
    expect(values[7] & 0x0f).toBe(0x0f);
  });

  it('starts the six-button sequence again after TH is left alone', () => {
    const controllers = new Controllers();
    readPairs(controllers, 3, 100_000);
    const values = readPairs(controllers, 1, 300_000);
    expect(values[1] & 0x0c).toBe(0);
    expect(values[0]).toBe(0x7f);
  });
});
