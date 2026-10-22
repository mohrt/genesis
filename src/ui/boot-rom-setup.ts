export interface BootRomSetupCallbacks {
  /** A boot ROM image was chosen or dropped (or a zip with one in). */
  onFile(file: File): Promise<void>;
  onForget(): Promise<void>;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Boot ROM setup is missing ${selector}`);
  return element;
}

/** The optional TMSS boot ROM's setup, shown in place of the screen: add, check or forget it. */
export class BootRomSetup {
  private readonly fileInput: HTMLInputElement;
  private readonly entry: HTMLElement;
  private readonly status: HTMLElement;
  private readonly message: HTMLElement;
  private readonly useBootRom: HTMLInputElement;
  private readonly forgetButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: BootRomSetupCallbacks,
  ) {
    this.fileInput = requireChild(root, 'input[name="boot-rom-file"]');
    this.entry = requireChild(root, '.bios-rom');
    this.status = requireChild(root, '.bios-rom-status');
    this.message = requireChild(root, '.bios-setup-message');
    this.useBootRom = requireChild(root, 'input[name="use-boot-rom"]');
    this.forgetButton = requireChild(root, '[data-action="forget-boot-rom"]');
    this.backButton = requireChild(root, '[data-action="back"]');

    requireChild<HTMLButtonElement>(root, '[data-action="choose-boot-rom-file"]').addEventListener('click', () =>
      this.fileInput.click(),
    );
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.run(() => this.callbacks.onFile(file));
    });
    this.forgetButton.addEventListener('click', () => {
      if (confirm('Forget the boot ROM? Games will start straight away again.')) this.run(() => this.callbacks.onForget());
    });
  }

  /** Shows whether a boot ROM is kept, and the name of its file if it was given since the page opened. */
  showBootRom(kept: boolean, fileName: string | null): void {
    const loaded = `Loaded: ${fileName ?? 'kept in this browser'}`;
    if (!kept) {
      this.entry.dataset.state = 'missing';
      this.status.textContent = 'Not loaded: games start straight away';
    } else if (!this.useBootRom.checked) {
      this.entry.dataset.state = 'warning';
      this.status.textContent = `${loaded}, but not used while "Start through the TMSS boot ROM" is unticked`;
    } else {
      this.entry.dataset.state = 'loaded';
      this.status.textContent = loaded;
    }
    this.forgetButton.hidden = !kept;
    this.useBootRom.disabled = !kept;
  }

  /** Shows the setup in place of the screen; resolves when the user goes back (Back to the console, or Esc). */
  open(): Promise<void> {
    const listeners = new AbortController();
    const signal = listeners.signal;
    this.message.textContent = '';

    return new Promise((resolve) => {
      const close = () => {
        listeners.abort();
        this.root.hidden = true;
        this.root.classList.remove('drag-over');
        document.body.classList.remove('choosing-boot-rom');
        resolve();
      };
      this.backButton.addEventListener('click', close, { signal });
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape') close();
        },
        { signal },
      );

      // Captured and stopped so the cartridge panel's page-wide drop handling doesn't also see the boot ROM.
      const dragOptions = { signal, capture: true };
      const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
      let depth = 0;
      window.addEventListener(
        'dragenter',
        (event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          depth++;
          this.root.classList.add('drag-over');
        },
        dragOptions,
      );
      window.addEventListener(
        'dragover',
        (event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        },
        dragOptions,
      );
      window.addEventListener(
        'dragleave',
        (event) => {
          if (!hasFiles(event)) return;
          event.stopImmediatePropagation();
          depth = Math.max(0, depth - 1);
          if (depth === 0) this.root.classList.remove('drag-over');
        },
        dragOptions,
      );
      window.addEventListener(
        'drop',
        (event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          depth = 0;
          this.root.classList.remove('drag-over');
          const file = event.dataTransfer?.files[0];
          if (file) this.run(() => this.callbacks.onFile(file));
        },
        dragOptions,
      );

      document.body.classList.add('choosing-boot-rom');
      this.root.hidden = false;
      this.root.scrollIntoView({ block: 'start' });
    });
  }

  private run(action: () => Promise<void>): void {
    this.message.textContent = '';
    action().catch((error: unknown) => (this.message.textContent = error instanceof Error ? error.message : String(error)));
  }
}
