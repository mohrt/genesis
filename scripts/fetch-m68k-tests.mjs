// Downloads Tom Harte's SingleStepTests for the 68000 (MIT licensed, about 200 MB, not
// committed): slightly over 8,000 single-instruction tests for each kind of instruction.
// Pass names to fetch only some, e.g. `npm run fetch:m68k -- ADD.w DIVU`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'e0d5ece9670205cc84a0101081837deb446f86a3';
const base = `https://raw.githubusercontent.com/SingleStepTests/680x0/${COMMIT}/68000/v1`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'm68000');

const ALL = [
  'ABCD', 'ADD.b', 'ADD.l', 'ADD.w', 'ADDA.l', 'ADDA.w', 'ADDX.b', 'ADDX.l', 'ADDX.w', 'AND.b', 'AND.l', 'AND.w',
  'ANDItoCCR', 'ANDItoSR', 'ASL.b', 'ASL.l', 'ASL.w', 'ASR.b', 'ASR.l', 'ASR.w', 'BCHG', 'BCLR', 'BSET', 'BSR',
  'BTST', 'Bcc', 'CHK', 'CLR.b', 'CLR.l', 'CLR.w', 'CMP.b', 'CMP.l', 'CMP.w', 'CMPA.l', 'CMPA.w', 'DBcc', 'DIVS',
  'DIVU', 'EOR.b', 'EOR.l', 'EOR.w', 'EORItoCCR', 'EORItoSR', 'EXG', 'EXT.l', 'EXT.w', 'JMP', 'JSR', 'LEA', 'LINK',
  'LSL.b', 'LSL.l', 'LSL.w', 'LSR.b', 'LSR.l', 'LSR.w', 'MOVE.b', 'MOVE.l', 'MOVE.q', 'MOVE.w', 'MOVEA.l',
  'MOVEA.w', 'MOVEM.l', 'MOVEM.w', 'MOVEP.l', 'MOVEP.w', 'MOVEfromSR', 'MOVEfromUSP', 'MOVEtoCCR', 'MOVEtoSR',
  'MOVEtoUSP', 'MULS', 'MULU', 'NBCD', 'NEG.b', 'NEG.l', 'NEG.w', 'NEGX.b', 'NEGX.l', 'NEGX.w', 'NOP', 'NOT.b',
  'NOT.l', 'NOT.w', 'OR.b', 'OR.l', 'OR.w', 'ORItoCCR', 'ORItoSR', 'PEA', 'RESET', 'ROL.b', 'ROL.l', 'ROL.w',
  'ROR.b', 'ROR.l', 'ROR.w', 'ROXL.b', 'ROXL.l', 'ROXL.w', 'ROXR.b', 'ROXR.l', 'ROXR.w', 'RTE', 'RTR', 'RTS',
  'SBCD', 'SUB.b', 'SUB.l', 'SUB.w', 'SUBA.l', 'SUBA.w', 'SUBX.b', 'SUBX.l', 'SUBX.w', 'SWAP', 'Scc', 'TAS',
  'TRAP', 'TRAPV', 'TST.b', 'TST.l', 'TST.w', 'UNLINK',
];

const wanted = process.argv.length > 2 ? process.argv.slice(2) : ALL;
await mkdir(outDir, { recursive: true });
for (const name of wanted) {
  const file = join(outDir, `${name}.json.gz`);
  if (existsSync(file)) continue;
  const response = await fetch(`${base}/${encodeURIComponent(name)}.json.gz`);
  if (!response.ok) {
    console.error(`Download of ${name} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  console.log(`Saved ${file}`);
}
