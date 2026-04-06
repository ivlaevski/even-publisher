import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'build-version.json');

const raw = readFileSync(path, 'utf8');
const data = JSON.parse(raw);
if (typeof data.build !== 'number' || !Number.isFinite(data.build)) {
  throw new Error('build-version.json: invalid "build" field');
}
data.build += 1;
writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
