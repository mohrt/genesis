import { AudioOutput } from './audio/audio-output';
import { Cartridge } from './cart/cartridge';
import { detectRom, type Region, type RomInfo, type TvSystem } from './cart/detect';
import { BATTERY_EXTENSION, STATE_EXTENSION, filesFrom, readMedia, titleFromFileName } from './cart/load';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import { KeyboardInput } from './io/keyboard-input';
import { Screen } from './render/screen';
import { BatterySaves, batteryKey } from './storage/battery-saves';
import { BootRomStore, checkBootRom, looksLikeBootRom } from './storage/boot-rom-store';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { CartPanel } from './ui/cart-panel';
import { downloadFile } from './ui/download';
import { Settings } from './ui/settings';
import { attachToolbar, type ConsoleChoices } from './ui/toolbar';
import { OnScreenPad } from './ui/touch-pad';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['region', 'tv', 'pad', 'use-boot-rom', 'show-pad', 'pad-player', 'sound', 'volume'];

const PLAYERS = 2;
/** How often changed battery saves are written to browser storage. */
const BATTERY_SAVE_INTERVAL_MS = 2000;

interface CurrentCartridge {
  info: RomInfo;
  fileName: string;
  title: string;
  cartridge: Cartridge;
  batteryKey: string;
}

/** How the console is set up for a cartridge: the toolbar's choices, with 'auto' filled in from the cartridge. */
interface ConsoleSetup {
  region: Region;
  tv: TvSystem;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'genesis';

const sizeLabel = (bytes: number) => (bytes >= 0x100000 ? `${+(bytes / 0x100000).toFixed(2)}M` : `${Math.round(bytes / 1024)}K`);

function setupFor(choices: ConsoleChoices, info: RomInfo | null): ConsoleSetup {
  const region = choices.region !== 'auto' ? choices.region : (info?.region ?? 'export');
  const tv = choices.tv !== 'auto' ? choices.tv : (info?.tv ?? 'ntsc');
  return { region, tv };
}

/** One line about the cartridge, e.g. "1M · USA · save RAM". */
function describe(cart: CurrentCartridge): string {
  const { info } = cart;
  const parts = [sizeLabel(info.rom.length)];
  if (info.title && info.title.toLowerCase() !== cart.title.toLowerCase()) parts.push(info.title);
  if (info.region) parts.push(info.region === 'japan' ? 'Japanese' : info.tv === 'pal' ? 'European' : 'American');
  if (info.saveRam) parts.push('save RAM');
  if (info.interleaved) parts.push('.smd format');
  if (!info.hasHeader) parts.push('no Sega header');
  return parts.join(' · ');
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');

  try {
    const settings = new Settings();
    // The on-screen controller starts out shown on touch screens, until the player chooses.
    const showPad = requireElement<HTMLInputElement>('input[name="show-pad"]');
    showPad.checked = matchMedia('(pointer: coarse)').matches;
    settings.bind(document, REMEMBERED_SETTINGS);

    const screen = new Screen(canvas);
    screen.onAspect = (aspect) => document.documentElement.style.setProperty('--screen-aspect', aspect.toFixed(4));
    screen.onAspect(screen.aspect);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) emulator.setAudioRate(audio.sampleRate);

    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      return memoryStores();
    });
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const batterySaves = new BatterySaves(stores.battery as KeyValueStore<Uint8Array>);
    const bootRomStore = new BootRomStore(stores.bootRom as KeyValueStore<Uint8Array>);
    let bootRom: Uint8Array | null = await bootRomStore.load().catch(() => null);

    let current: CurrentCartridge | null = null;
    let bundledGames: BundledGame[] = [];
    let paused = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const parts = [current ? current.title : 'No cartridge', machine.tv.toUpperCase()];
      parts.push(machine.region === 'japan' ? 'Japan' : 'Export');
      parts.push(machine.controllers.padType === 'six' ? '6-button' : '3-button');
      if (machine.hasBootRom) parts.push('TMSS');
      status.textContent = `${parts.join(' · ')} · Arrows, Z X C, A S D and Enter play`;
      screenFrame.classList.toggle('empty', !machine.canRun);
    };

    /** Switches the console off and on, e.g. after its setup or boot ROM changed. */
    const powerCycle = () => {
      machine.powerOn();
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Boot ROM --------------------------------------------------------------------
    const useBootRom = requireElement<HTMLInputElement>('input[name="use-boot-rom"]');
    const applyBootRom = () => {
      machine.setBootRom(useBootRom.checked ? bootRom : null);
      cartPanel.showBootRom(bootRom !== null);
    };
    useBootRom.addEventListener('change', () => {
      applyBootRom();
      powerCycle();
      focusScreen();
    });
    const useBootRomImage = async (bytes: Uint8Array) => {
      const image = checkBootRom(bytes);
      await bootRomStore.save(image);
      bootRom = image;
      useBootRom.checked = true;
      useBootRom.dispatchEvent(new Event('change'));
      cartPanel.showMessage('TMSS boot ROM kept in this browser; the console was switched off and on to use it.', true);
    };

    /** Sets the console up for the current cartridge and the toolbar's choices. */
    const applySetup = () => {
      const setup = setupFor(toolbar.choices, current?.info ?? null);
      machine.setRegion(setup.region);
      emulator.setTv(setup.tv);
      machine.setPadType(toolbar.choices.pad);
    };

    // --- Battery saves ---------------------------------------------------------------
    const saveBattery = async () => {
      const cart = current?.cartridge;
      const data = cart?.saveData;
      if (!current || !cart || !data || !cart.batteryDirty) return;
      cart.batteryDirty = false;
      await batterySaves.save(current.batteryKey, data);
    };
    const saveBatterySoon = () => {
      cartPanel.setHasSave(current?.cartridge.saveData != null);
      void saveBattery().catch((error: unknown) => console.warn('Could not keep the game save:', error));
    };
    setInterval(saveBatterySoon, BATTERY_SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveBatterySoon();
    });
    window.addEventListener('pagehide', saveBatterySoon);

    // --- Cartridges ------------------------------------------------------------------
    /** A cartridge with its saved game (if any) loaded. */
    const buildCartridge = async (info: RomInfo, key: string): Promise<Cartridge> => {
      const cartridge = new Cartridge(info.rom, info.saveRam);
      const saved = await batterySaves.load(key).catch(() => undefined);
      if (saved) cartridge.loadSaveData(saved);
      return cartridge;
    };

    const loadCartridge = async (image: Uint8Array, fileName: string, knownTitle?: string) => {
      const info = detectRom(image, fileName);
      const key = batteryKey(info.rom);
      const cart: CurrentCartridge = {
        info,
        fileName,
        title: knownTitle ?? titleFromFileName(fileName.split(' from ')[0]),
        cartridge: await buildCartridge(info, key),
        batteryKey: key,
      };
      cartPanel.showCartridge(cart.title, fileName, describe(cart), cart.cartridge.saveData !== null);
      return cart;
    };

    const insertImage = async (image: Uint8Array, fileName: string, knownTitle?: string) => {
      const next = await loadCartridge(image, fileName, knownTitle);
      await saveBattery();
      current = next;
      applySetup();
      machine.insertCartridge(next.cartridge);
      emulator.resetTiming();
      audio?.flush();
      updateCanSave();
      updateStatus();
    };

    const eject = () => {
      saveBatterySoon();
      machine.insertCartridge(null);
      current = null;
      cartPanel.showEmpty();
      updateCanSave();
      updateStatus();
    };

    const useBatteryFile = async (bytes: Uint8Array) => {
      const cart = current?.cartridge;
      if (!current || !cart) throw new Error('Insert the game first, then drop its .sav file.');
      cart.loadSaveData(bytes);
      cart.batteryDirty = true;
      await saveBattery();
      machine.powerOn();
      audio?.flush();
      cartPanel.setHasSave(true);
      cartPanel.showMessage('Game save loaded; the console was switched off and on to use it.', true);
    };

    // --- Save states -----------------------------------------------------------------
    const currentSession = (): Session => {
      if (!current) throw new Error('Insert a cartridge first.');
      return { machine: machine.saveState(), rom: current.info.rom, romName: current.fileName, title: current.title };
    };
    const restoreSession = async (session: Session) => {
      const next = await loadCartridge(session.rom, session.romName, session.title);
      await saveBattery();
      current = next;
      machine.insertCartridge(next.cartridge);
      machine.loadState(session.machine);
      emulator.restored();
      updateCanSave();
      audio?.flush();
      updateStatus();
    };
    const updateCanSave = () => toolbar.setCanSave(current !== null);

    // --- Panels ----------------------------------------------------------------------
    const cartPanel = new CartPanel(requireElement('#cart-panel'), {
      onFile: async (file) => {
        const files = await filesFrom(file);
        const fromZip = files[0] !== file;
        const chosen = files[0];
        if (fromZip) cartPanel.setZipFiles(files, chosen.name);
        else if (cartPanel.zipContents.includes(file)) cartPanel.setZipFiles(cartPanel.zipContents, file.name);
        else cartPanel.setZipFiles([], null);
        if (looksLikeBootRom(chosen.name)) {
          await useBootRomImage(new Uint8Array(await chosen.arrayBuffer()));
          return;
        }
        const media = await readMedia(chosen);
        if (media.kind === 'state') {
          await restoreSession(await decodeSession(media.bytes));
          toolbar.showMessage('Save state loaded');
          return;
        }
        if (media.kind === 'battery') {
          await useBatteryFile(media.bytes);
          return;
        }
        const game = bundledGames.find((entry) => entry.file.split('/').pop() === chosen.name);
        await insertImage(media.image, fromZip ? `${chosen.name} from ${file.name}` : chosen.name, game?.title);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onEject: eject,
      onExportSave: () => {
        const data = current?.cartridge.saveData;
        if (current && data) downloadFile(data, `${slug(current.title)}${BATTERY_EXTENSION}`);
      },
      onBootRomFile: async (file) => {
        const [chosen] = await filesFrom(file).catch(() => [file]);
        await useBootRomImage(new Uint8Array(await chosen.arrayBuffer()));
      },
      onForgetBootRom: async () => {
        await bootRomStore.forget();
        bootRom = null;
        applyBootRom();
        powerCycle();
      },
      focusScreen,
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => machine.pressReset(),
      onPowerCycle: () => {
        machine.powerOn();
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onConsole: () => {
        // Games look at the console they are on when they start, so a change means switching off and on.
        applySetup();
        powerCycle();
      },
      onSaveState: async () => {
        const session = currentSession();
        await saveStates.add(session.title, session);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const session = currentSession();
        downloadFile(await encodeSession(session), `${slug(session.title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      cartPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    // --- Inputs ----------------------------------------------------------------------
    const [player1, player2] = machine.controllers.inputs;
    new KeyboardInput(player1, { onPause: () => toolbar.setPaused(!toolbar.paused) }).attach(window);
    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const padRoot = requireElement<HTMLElement>('#pad');
    const pad = new OnScreenPad(padRoot, player1, focusScreen);
    const padPlayer = requireElement<HTMLSelectElement>('select[name="pad-player"]');
    const applyPad = () => {
      padRoot.hidden = !showPad.checked;
      pad.setController(padPlayer.value === '1' ? player2 : player1);
    };
    showPad.addEventListener('change', applyPad);
    padPlayer.addEventListener('change', applyPad);
    applyPad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -----------------------------------------------------------------
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      for (let player = 0; player < PLAYERS; player++) {
        const gamepad = pads[player];
        const input = machine.controllers.inputs[player];
        if (gamepad) input.set('gamepad', readGamepad(gamepad));
        else input.clear('gamepad');
      }
      const names = pads
        .slice(0, PLAYERS)
        .map((gamepad, player) => `Player ${player + 1}: ${padName(gamepad)}`)
        .join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    const frame = (now: number) => {
      const elapsed = now - last;
      last = now;
      pollGamepads();
      if (!paused) {
        emulator.run(elapsed);
        audio?.play(emulator.takeAudioSamples());
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    applySetup();
    applyBootRom();
    machine.powerOn();
    cartPanel.showEmpty();
    updateCanSave();
    updateStatus();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
