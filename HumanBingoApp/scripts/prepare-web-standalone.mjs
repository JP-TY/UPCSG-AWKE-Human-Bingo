import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '../packages/web');
const standaloneWeb = path.join(webDirectory, '.next/standalone/packages/web');
const standaloneNext = path.join(standaloneWeb, '.next');

await mkdir(standaloneNext, { recursive: true });
await cp(path.join(webDirectory, '.next/static'), path.join(standaloneNext, 'static'), {
  recursive: true,
  force: true,
});
await cp(path.join(webDirectory, 'public'), path.join(standaloneWeb, 'public'), {
  recursive: true,
  force: true,
});

console.log('Next.js standalone assets prepared');
