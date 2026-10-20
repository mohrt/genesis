import { Button, type ControllerInput } from './controllers';

const BUTTON_KEYS: Record<string, number> = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
  KeyZ: Button.A,
  KeyX: Button.B,
  KeyC: Button.C,
  KeyA: Button.X,
  KeyS: Button.Y,
  KeyD: Button.Z,
  KeyJ: Button.A,
  KeyK: Button.B,
  KeyL: Button.C,
  KeyU: Button.X,
  KeyI: Button.Y,
  KeyO: Button.Z,
  Enter: Button.Start,
  ShiftRight: Button.Mode,
};
const PAUSE_KEYS = new Set(['Pause', 'KeyP']);

export interface KeyboardCallbacks {
  onPause(): void;
}

/** True when a key press belongs to a form field rather than the game. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * Player 1 on the keyboard: arrows for the D-pad, Z, X and C (or J, K and L)
 * for A, B and C, A, S and D (or U, I and O) for X, Y and Z, Enter for Start
 * and right Shift for Mode. P pauses the emulator.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor(
    private readonly controller: ControllerInput,
    private readonly callbacks: KeyboardCallbacks,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => {
      this.held.clear();
      this.update();
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (down && (event.ctrlKey || event.metaKey || event.altKey || typingInField(event))) return;
    const code = event.code;
    if (PAUSE_KEYS.has(code)) {
      if (down && !event.repeat) this.callbacks.onPause();
      event.preventDefault();
      return;
    }
    if (!(code in BUTTON_KEYS)) return;
    event.preventDefault();
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.update();
  }

  private update(): void {
    let buttons = 0;
    for (const code of this.held) buttons |= BUTTON_KEYS[code] ?? 0;
    this.controller.set('keyboard', { buttons });
  }
}
