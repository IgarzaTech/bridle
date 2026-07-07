#!/usr/bin/env node
/**
 * Extrae la sección de una versión del CHANGELOG.md y la imprime a stdout.
 * Se usa como cuerpo de la GitHub Release (release.yml y backfill-releases.yml).
 *
 * Uso: node scripts/changelog-notes.mjs 0.2.3   (o v0.2.3)
 * Sale con código 2 si no hay sección para esa versión.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] || '').replace(/^v/, '').trim();
if (!version) {
  console.error('uso: changelog-notes.mjs <version>');
  process.exit(1);
}

const md = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');
const lines = md.split(/\r?\n/);
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headingRe = new RegExp(`^##\\s*\\[${esc}\\]`);

const start = lines.findIndex((l) => headingRe.test(l));
if (start === -1) {
  console.error(`No hay sección para ${version} en CHANGELOG.md`);
  process.exit(2);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s*\[/.test(lines[i])) { end = i; break; }
}

const body = lines
  .slice(start + 1, end)
  // quita las definiciones de referencia de enlaces ([0.2.3]: https://…) por si caen dentro
  .filter((l) => !/^\[[\d.]+\]:\s+https?:/.test(l))
  .join('\n')
  .trim();

process.stdout.write(body + '\n');
