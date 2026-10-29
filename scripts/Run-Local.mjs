import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { runSupervisor } from './runtime-supervisor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = parse(readFileSync(join(root, '.env')));
const dataDir = resolve(root, settings.DATA_DIR || './data');
const backupDir = join(root, 'backups');
if (!dataDir.toLowerCase().startsWith(root.toLowerCase() + sep) || dataDir.toLowerCase() === backupDir.toLowerCase() || dataDir.toLowerCase().startsWith(backupDir.toLowerCase() + sep)) throw new Error('DATA_DIR must be inside this project and outside backups.');
process.exitCode = await runSupervisor({ root, dataDir, env: { ...process.env, ...settings, DATA_DIR: dataDir } });
