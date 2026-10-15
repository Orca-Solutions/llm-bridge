// Locate the pinned Codex CLI binary the way the SDK does, so the guard can
// run it (the SDK only finds it itself when it starts it directly).
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

export function findCodexBinary(): { bin: string; pathDirs: string[] } {
  const key = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[key];
  if (!triple) throw new Error(`no Codex binary for ${key}`);
  const req = createRequire(import.meta.url);
  const codexPkg = createRequire(req.resolve('@openai/codex/package.json'));
  const vendor = join(dirname(codexPkg.resolve(`@openai/codex-${key}/package.json`)), 'vendor', triple);
  const bin = join(vendor, 'bin', 'codex');
  if (!existsSync(bin) || !statSync(bin).isFile()) throw new Error(`Codex binary missing at ${bin}; run npm ci`);
  const pathDir = join(vendor, 'codex-path');
  return { bin, pathDirs: existsSync(pathDir) ? [pathDir] : [] };
}
