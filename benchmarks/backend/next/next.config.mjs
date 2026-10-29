import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
export default { poweredByHeader: false, turbopack: { root }, outputFileTracingRoot: root };
