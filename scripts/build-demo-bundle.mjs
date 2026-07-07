#!/usr/bin/env node
/**
 * Regenera el bundle del demo de la web y sincroniza el badge de versión.
 *
 * El demo de la landing (docs/) corre el paquete REAL @igarzatech/bridle en el
 * navegador. Este script:
 *   1. instala @igarzatech/bridle@<versión> en un dir temporal,
 *   2. lo empaqueta a un ESM self-hosted (esbuild) → docs/vendor/bridle.min.js,
 *   3. actualiza el string de versión del badge en docs/index.html y docs/es/index.html.
 *
 * Uso:
 *   node scripts/build-demo-bundle.mjs            # vendoriza la 'latest' de npm
 *   node scripts/build-demo-bundle.mjs 0.2.4      # una versión exacta
 *   BRIDLE_VERSION=0.2.4 node scripts/build-demo-bundle.mjs
 *
 * Idempotente: si el bundle y el badge ya están al día, no cambia nada.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ESBUILD = 'esbuild@0.24.0'; // pineado: mismo output byte-a-byte entre corridas
const PKG = '@igarzatech/bridle';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const wanted = process.argv[2] || process.env.BRIDLE_VERSION || 'latest';

/** Sleep bloqueante cross-plataforma (sin depender de `sleep`/timers async). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

const tmp = mkdtempSync(join(tmpdir(), 'bridle-demo-'));
try {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ private: true, name: 'bridle-demo-build' }));

  // Instala con reintentos: tras un release recién publicado, npm puede tardar
  // unos segundos en propagar la nueva versión al registry.
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    try {
      run(`npm install ${PKG}@${wanted} --no-audit --no-fund --loglevel=error`, tmp);
      ok = true;
    } catch (e) {
      console.log(`[demo-bundle] npm install intento ${i + 1} falló; reintento en 15s…`);
      sleep(15000);
    }
  }
  if (!ok) throw new Error(`No se pudo instalar ${PKG}@${wanted} tras varios intentos`);

  const version = JSON.parse(
    readFileSync(join(tmp, 'node_modules', '@igarzatech', 'bridle', 'package.json'), 'utf8'),
  ).version;
  console.log(`[demo-bundle] versión resuelta: ${version}`);

  // Entry mínimo: solo lo que el demo usa del paquete real.
  writeFileSync(
    join(tmp, 'entry.mjs'),
    `export { BridleGuard, InMemoryStorage, BudgetExceededError } from '${PKG}';\n`,
  );

  const outTmp = join(tmp, 'out.js');
  run(`npx --yes ${ESBUILD} "${join(tmp, 'entry.mjs')}" --bundle --format=esm --minify "--outfile=${outTmp}"`, tmp);

  const banner =
    `// ${PKG}@${version} — paquete real publicado (core + InMemoryStorage),\n` +
    `// empaquetado para el demo del navegador con esbuild. Fuente: https://github.com/IgarzaTech/bridle\n` +
    `// GENERADO por scripts/build-demo-bundle.mjs — no editar a mano.\n`;
  const bundle = banner + readFileSync(outTmp, 'utf8');
  const vendorPath = join(repoRoot, 'docs', 'vendor', 'bridle.min.js');
  writeFileSync(vendorPath, bundle);
  console.log(`[demo-bundle] escrito ${vendorPath} (${bundle.length} bytes)`);

  // Sincroniza el string de versión del badge. En cada HTML solo aparece una vez
  // con versión: dentro de setEngine ("@igarzatech/bridle@X.Y.Z"). El resto de
  // menciones (scope, install, links npm) van sin versión y no se tocan.
  const re = /@igarzatech\/bridle@\d+\.\d+\.\d+/g;
  for (const rel of ['docs/index.html', 'docs/es/index.html']) {
    const p = join(repoRoot, rel);
    const before = readFileSync(p, 'utf8');
    const after = before.replace(re, `${PKG}@${version}`);
    if (after !== before) {
      writeFileSync(p, after);
      console.log(`[demo-bundle] badge actualizado en ${rel} → ${version}`);
    }
  }
  console.log('[demo-bundle] listo.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
