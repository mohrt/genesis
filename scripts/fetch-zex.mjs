// Downloads Frank Cringle's ZEXDOC and ZEXALL Z80 instruction exercisers (GPL, not committed).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'https://raw.githubusercontent.com/agn453/ZEXALL/main';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'zex');

await mkdir(outDir, { recursive: true });
for (const name of ['zexdoc.com', 'zexall.com']) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) {
    console.error(`Download of ${name} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const outFile = join(outDir, name);
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
  console.log(`Saved ${outFile}`);
}
