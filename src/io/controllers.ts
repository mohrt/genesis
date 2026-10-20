/** Controller buttons, as bits of a pad's state. */
export const Button = {
  Up: 0x001,
  Down: 0x002,
  Left: 0x004,
  Right: 0x008,
  B: 0x010,
  C: 0x020,
  A: 0x040,
  Start: 0x080,
  Z: 0x100,
  Y: 0x200,
  X: 0x400,
  Mode: 0x800,
} as const;

/** The three-button pad, or the six-button one (whose X, Y, Z and Mode some older games can't cope with). */
export type PadType = 'three' | 'six';

export interface PadState {
  /** Held buttons (Button bits). */
  buttons: number;
}

const idle = (): PadState => ({ buttons: 0 });

/** One controller, pressed by several input sources (keyboard, gamepad, on-screen pad) at once. */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();

  set(source: string, state: Partial<PadState>): void {
    this.sources.set(source, { ...idle(), ...state });
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  get state(): PadState {
    const merged = idle();
    for (const state of this.sources.values()) merged.buttons |= state.buttons;
    return merged;
  }
}

/** A D-pad can't press opposite directions together; some games misbehave if they see it. */
function withoutOpposites(buttons: number): number {
  if ((buttons & (Button.Up | Button.Down)) === (Button.Up | Button.Down)) buttons &= ~(Button.Up | Button.Down);
  if ((buttons & (Button.Left | Button.Right)) === (Button.Left | Button.Right)) buttons &= ~(Button.Left | Button.Right);
  return buttons;
}

/** The six-button pad goes back to its first step when TH is left alone for about 1.5 ms. */
const SIX_BUTTON_TIMEOUT_CYCLES = 11_500;
const TH = 0x40;

/**
 * A controller port of the I/O chip: a data register and a control register
 * that sets each of its 7 pins as an input or an output. Pads are read by
 * switching the TH pin: high gives Up, Down, Left, Right, B and C; low gives
 * Up, Down, A and Start. The six-button pad counts TH changes and on the
 * third and fourth low-high pairs reports X, Y, Z and Mode.
 */
export class ControllerPort {
  data = 0;
  control = 0;
  /** TH changes since the six-button pad last went back to its first step. */
  step = 0;
  lastChange = 0;

  reset(): void {
    this.data = this.control = this.step = 0;
    this.lastChange = 0;
  }

  /** The level on TH: driven by the data register when it is an output, pulled high otherwise. */
  get th(): boolean {
    return this.control & TH ? (this.data & TH) !== 0 : true;
  }

  writeData(value: number, now: number): void {
    const th = this.th;
    this.data = value;
    this.noteTh(th, now);
  }

  writeControl(value: number, now: number): void {
    const th = this.th;
    this.control = value;
    this.noteTh(th, now);
  }

  private noteTh(before: boolean, now: number): void {
    const th = this.th;
    if (th === before) return;
    if (now - this.lastChange > SIX_BUTTON_TIMEOUT_CYCLES) this.step = th ? 0 : 1;
    else this.step = (this.step + 1) & 7;
    this.lastChange = now;
  }

  /** The data register as read: outputs read back what was written, inputs the pad's pins (0 = pressed). */
  read(buttons: number, type: PadType, now: number): number {
    if (type === 'six' && now - this.lastChange > SIX_BUTTON_TIMEOUT_CYCLES) this.step = this.th ? 0 : 1;
    const pins = this.pins(buttons, type);
    const outputs = this.control & 0x7f;
    return (this.data & (outputs | 0x80)) | (pins & ~outputs & 0x7f);
  }

  private pins(buttons: number, type: PadType): number {
    const pressed = (bit: number, shift: number) => (buttons & bit ? 0 : 1 << shift);
    if (this.th) {
      if (type === 'six' && this.step === 6) {
        return TH | pressed(Button.Z, 0) | pressed(Button.Y, 1) | pressed(Button.X, 2) | pressed(Button.Mode, 3) | pressed(Button.B, 4) | pressed(Button.C, 5);
      }
      return TH | (~buttons & 0x3f);
    }
    const startA = pressed(Button.A, 4) | pressed(Button.Start, 5);
    if (type === 'six' && this.step === 5) return startA;
    if (type === 'six' && this.step === 7) return startA | 0x0f;
    return startA | (~buttons & 0x03);
  }
}

/** The two controller ports and the pads plugged into them. */
export class Controllers {
  readonly inputs: readonly [ControllerInput, ControllerInput] = [new ControllerInput(), new ControllerInput()];
  readonly ports = [new ControllerPort(), new ControllerPort()];
  padType: PadType = 'six';

  reset(): void {
    for (const port of this.ports) port.reset();
  }

  /** Player `port`'s held buttons (Button bits). */
  buttons(port: 0 | 1): number {
    return withoutOpposites(this.inputs[port].state.buttons);
  }

  read(port: 0 | 1, now: number): number {
    return this.ports[port].read(this.buttons(port), this.padType, now);
  }
}
