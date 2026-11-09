import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const root = process.env.AGENTS_BENCH_ROOT || process.cwd();
  if (specifier.startsWith('@/')) {
    return nextResolve(pathToFileURL(path.join(root, 'src', specifier.slice(2))).href, context);
  }
  if (specifier.startsWith('open-sse/')) {
    return nextResolve(pathToFileURL(path.join(root, specifier)).href, context);
  }
  return nextResolve(specifier, context);
}
