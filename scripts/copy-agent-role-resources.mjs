import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const resourceNames = [
  'common.md',
  'main-planning.md',
  'runner-execution.md',
  'reviewer-audit.md',
  'main-finalization.md',
  'scenario-initialization.md',
];
const source = resolve('resources/agent-roles');
const destination = resolve('dist/resources/agent-roles');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of resourceNames) {
  const sourcePath = resolve(source, name);
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile()) throw new Error(`agent role resource is not a regular file: ${name}`);
  const content = await readFile(sourcePath, 'utf8');
  if (content.trim() === '') throw new Error(`agent role resource is empty: ${name}`);
  await cp(sourcePath, resolve(destination, name), {
    dereference: true,
    errorOnExist: true,
  });
}
