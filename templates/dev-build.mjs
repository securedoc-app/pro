// SecureDoc - construye la version de PRODUCCION (minificada y ofuscada) a partir de src/.
// Lo instala SecureDoc en el repositorio de desarrollo y lo ejecuta el flujo de GitHub Actions
// .github/workflows/securedoc-publish.yml. Puedes editarlo; "Reinstalar flujo" en SecureDoc lo restaura.
//
// Configuracion en .securedoc/config.json:
//   src        carpeta con tu codigo fuente (por defecto "src")
//   out        carpeta de salida temporal (por defecto "dist")
//   obfuscate  true = minificar y ofuscar el JavaScript; false = solo minificar
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { minify as minifyHtml } from 'html-minifier-terser';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cfg = { src: 'src', out: 'dist', obfuscate: true, ...JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8')) };

const inside = (p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const srcDir = path.resolve(root, cfg.src);
const outDir = path.resolve(root, cfg.out);
if (!inside(srcDir) || !inside(outDir)) throw new Error('src y out deben estar dentro del repositorio');

const OBFUSCATOR = {
  compact: true, simplify: true, target: 'browser',
  renameGlobals: false,                 // no se renombran las variables globales (las paginas y otros scripts las usan)
  // NUNCA renombrar estos nombres: SecureDoc lo INYECTA el runtime (no existe en tu
  // codigo fuente) y sus metodos deben conservar el nombre exacto para que el puente
  // funcione. Sin esto, la ofuscacion puede dejar "SecureDoc is not defined".
  reservedNames: ['^SecureDoc$', '^AppRunner$'],
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true, stringArrayThreshold: 0.75, stringArrayEncoding: ['base64'], stringArrayWrappersCount: 1,
  splitStrings: false, controlFlowFlattening: false, deadCodeInjection: false,
  selfDefending: false, debugProtection: false, numbersToExpressions: false, unicodeEscapeSequence: false
};

const isModule = (code) => /^\s*(import\s+[\w{*"']|export\s+[\w{*])/m.test(code);
const safeInline = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

// `prefix` DEBE ser distinto para cada bloque/archivo obfuscado que termine viviendo
// en el mismo ambito (varios <script> del mismo index.html comparten el scope global
// del documento). El obfuscador genera su "string array" y su decodificador con nombres
// como _0x14a462; si dos bloques se ofuscan por separado pueden generar el MISMO nombre
// y pisarse -> "_0x14a462 is not defined". Un identifiersPrefix unico por bloque lo evita.
async function processJs(code, forceModule, prefix) {
  const module = forceModule || isModule(code);
  const min = await transform(code, { loader: 'js', minify: true, legalComments: 'none', ...(module ? { format: 'esm' } : {}) });
  if (!cfg.obfuscate) return min.code;
  const opts = { ...OBFUSCATOR, sourceType: module ? 'module' : 'script' };
  if (prefix) opts.identifiersPrefix = prefix;
  return JavaScriptObfuscator.obfuscate(min.code, opts).getObfuscatedCode();
}

async function processCss(code) {
  return (await transform(code, { loader: 'css', minify: true, legalComments: 'none' })).code;
}

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);
async function processHtml(html) {
  // 1) Scripts en linea: se minifican/ofuscan uno por uno (los de tipo JSON u otros se dejan como estan).
  //    Marcadores por <script> para controlar QUE se toca (lo que pediste "que no cambie"):
  //      data-sd="raw"  -> se deja EXACTAMENTE igual (ni minificar ni ofuscar)
  //      data-sd="min"  -> solo se minifica (nunca se ofusca)
  //      (sin marca)    -> se minifica y se ofusca (comportamiento por defecto)
  //    Cada bloque ofuscado recibe un prefijo unico (_sdN_) para no colisionar entre si.
  const re = /(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi;
  const found = [...html.matchAll(re)];
  let out = '', last = 0, blockIndex = 0;
  for (const m of found) {
    const attrs = m[2] || '';
    const type = ((/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '').toLowerCase();
    const sd = ((/\bdata-sd\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '').toLowerCase();
    const body = m[3];
    // Etiqueta de apertura sin el atributo data-sd (es solo una instruccion de build)
    const openTag = m[1].replace(/\s*data-sd\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
    out += html.slice(last, m.index);
    if (/\bsrc\s*=/i.test(attrs) || !JS_TYPES.has(type) || !body.trim() || sd === 'raw') {
      // Externo, no-JS, vacio o marcado como "raw": se deja tal cual (solo se limpia data-sd).
      out += (sd ? openTag + body + m[4] : m[0]);
    } else if (sd === 'min') {
      const min = await transform(body, { loader: 'js', minify: true, legalComments: 'none', ...(type === 'module' ? { format: 'esm' } : {}) });
      out += openTag + safeInline(min.code) + m[4];
    } else {
      const prefix = '_sd' + (blockIndex++) + '_';
      out += openTag + safeInline(await processJs(body, type === 'module', prefix)) + m[4];
    }
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  // 2) Resto del HTML (y los <style>) con html-minifier-terser
  return minifyHtml(out, {
    collapseWhitespace: true, conservativeCollapse: true, removeComments: true,
    minifyCSS: true, minifyJS: false, useShortDoctype: true
  });
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const SKIP = new Set(['.DS_Store', 'Thumbs.db']);
let stat;
try { stat = await fs.stat(srcDir); } catch { stat = null; }
if (!stat || !stat.isDirectory()) throw new Error('No existe la carpeta "' + cfg.src + '/" en el repositorio de desarrollo. Pon ahi tu codigo fuente.');

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

let count = 0, before = 0, after = 0;
for await (const file of walk(srcDir)) {
  const rel = path.relative(srcDir, file);
  const base = path.basename(file);
  if (SKIP.has(base) || base.endsWith('.map')) continue;
  const dest = path.join(outDir, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ext = path.extname(file).toLowerCase();
  const buf = await fs.readFile(file);
  let outBuf = buf;
  try {
    if (ext === '.html' || ext === '.htm') outBuf = Buffer.from(await processHtml(buf.toString('utf8')));
    else if (ext === '.js' || ext === '.mjs') outBuf = Buffer.from(await processJs(buf.toString('utf8'), ext === '.mjs', '_sf_' + count + '_'));
    else if (ext === '.css') outBuf = Buffer.from(await processCss(buf.toString('utf8')));
    else if (ext === '.json') outBuf = Buffer.from(JSON.stringify(JSON.parse(buf.toString('utf8'))));
  } catch (e) {
    throw new Error(rel + ': ' + (e && e.message ? e.message : e));
  }
  await fs.writeFile(dest, outBuf);
  count++; before += buf.length; after += outBuf.length;
  console.log(rel.split(path.sep).join('/') + ': ' + buf.length + ' -> ' + outBuf.length + ' bytes');
}
if (!count) throw new Error('La carpeta "' + cfg.src + '/" esta vacia.');
await fs.writeFile(path.join(outDir, '.nojekyll'), '');   // GitHub Pages: sirve los archivos tal cual (sin Jekyll)
console.log('Listo: ' + count + ' archivo(s), ' + before + ' -> ' + after + ' bytes' + (cfg.obfuscate ? ' (minificado y ofuscado)' : ' (minificado)'));
