# Sega Genesis in the browser

**Play it at [mohrt.github.io/genesis](https://mohrt.github.io/genesis/)**

A Sega Genesis (Mega Drive) emulator written from scratch in TypeScript: a 68000 that passes Tom Harte's SingleStepTests for every instruction, cycle counts included (all but the stack frames of address errors, which games don't make); the Z80 that drives the sound (passing ZEXDOC and ZEXALL); the VDP, with its two scrolling planes, window, sprites, shadow and highlight, DMA and interlace mode; the YM2612 FM chip with its LFO, SSG-EG envelopes, timers and DAC; and the PSG. It runs three- and six-button pads, battery saves, and the bank switching of Super Street Fighter II. Drop a `.md`, `.bin`, `.gen` or `.smd` file (or a `.zip` containing one) onto the page to play it. No BIOS is needed; the Genesis doesn't have one to start games.

## Controls

- **Keyboard** (player 1): arrow keys for the D-pad, Z, X and C (or J, K and L) for A, B and C, A, S and D (or U, I and O) for X, Y and Z, Enter for Start, and right Shift for Mode. P or Pause pauses the emulator.
- **Gamepads** work as soon as you press one of their buttons: the first is player 1, the second player 2. They are laid out as in Sega's own collections: the left, bottom and right face buttons are A, B and C; the left shoulder, top face button and right shoulder are X, Y and Z; Start is Start and Back is Mode. Pads without a standard mapping work through their main axes or a hat switch.
- **On-screen controller**: a D-pad you can slide around on, Start, and A, B and C with X, Y and Z above them, for player 1 or player 2. It is shown on touch screens, and works with a mouse too.

## Console

The toolbar has pause, the console's Reset button, power cycle and full screen, and the console's setup:

- **Region**: Japan or export (USA, Europe). Auto goes by the file name, such as "(Japan)", then by the regions the cartridge's header lists, preferring an American console. Games check it, and some refuse the wrong one.
- **TV**: NTSC (60 Hz) or PAL (50 Hz). Auto picks PAL for European games. Only PAL consoles show the 240-line picture.
- **Controllers**: six-button pads, or three-button ones for the few older games that misread the six-button pad.

Changing the setup switches the console off and on, as games look at it when they start. Save states keep the whole console, cartridge included, in the browser. They can be exported and imported as `.mdstate` files.

Games that save to their cartridge (battery-backed RAM, as in Phantasy Star II) save in the browser by themselves. **Download .sav** appears once a game has used its save RAM, and dropping a `.sav` or `.srm` file onto the page while its game is in uses it.

## The TMSS boot ROM

Later Genesis consoles have a small boot ROM (TMSS) that shows "PRODUCED BY OR UNDER LICENSE FROM SEGA ENTERPRISES LTD." before the game. It is still under copyright, so none is included, and none is needed. If you have your own, the toolbar's **Boot ROM...** button shows the boot ROM setup in place of the screen (pausing the console): **Choose boot ROM file...**, or dropping a file onto the page while it is open, keeps it in the browser (so does dropping a file with "tmss", "boot" or "bios" in its name at any time). With **Start through the TMSS boot ROM** ticked, the console starts in it as those consoles do. **Forget** removes it, and **Back to the console** (or Esc) carries on.

## Cartridges

Cartridges up to 4M are mapped straight into the 68000's space; bigger ones use Sega's bank switcher. Save RAM goes where the header says, or at $200000 for games that don't say. Super Magic Drive (`.smd`) files are deinterleaved and copier headers are skipped. Not covered: the Sega CD and 32X add-ons, EEPROM saves (as in NBA Jam), and Master System games (play those in the [Master System emulator](https://mohrt.github.io/mastersystem/)).

No commercial games are included in this repository. Use images of cartridges you own. `npm run fetch:games` downloads the freely licensed homebrews listed in `scripts/games-catalog.json` (each with its credit, licence, source and checksum) into `public/games/`, where they appear in a "Free games" picker. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.md" }] }`.

## Development

```sh
npm install
npm run fetch:games       # optional: free games into public/games/
npm run dev               # http://localhost:5173
npm test                  # tests needing downloaded files skip when they're missing
npm run fetch:m68k        # optional: the 68000 SingleStepTests (about 200 MB), run by npm test
npm run fetch:zex         # optional: ZEXDOC and ZEXALL; run them with ZEX=1 npm test (a few minutes)
```

`npm test` also runs the free games and any `.md`, `.bin`, `.gen` or `.smd` files you put in `roms/`; `SHOTS=/tmp/shots npm test` saves screenshots of each. `M68K=ADD.w,DIVU npm test` runs only some of the 68000 tests.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the 68000 tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
