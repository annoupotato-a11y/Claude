/* index.html / style.css / app.js を1枚のHTMLにまとめる。
 *
 *   node tools/build-standalone.mjs                 → standalone.html（そのまま開ける1ファイル）
 *   node tools/build-standalone.mjs --body out.html → <body>の中身だけ（Artifact公開用）
 *   node tools/build-standalone.mjs --app calorie   → calorie/ のアプリを calorie/standalone.html に
 *
 * PWA（manifest・Service Worker）は複数ファイル前提なので、1ファイル版からは外す。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appIndex = process.argv.indexOf('--app');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', appIndex > -1 ? process.argv[appIndex + 1] : '');
const read = (p) => readFile(join(root, p), 'utf8');

const [html, css, js] = await Promise.all([read('index.html'), read('assets/style.css'), read('assets/app.js')]);

const inlined = html
  .replace(/<script data-pwa>[\s\S]*?<\/script>\n?/g, '')          // Service Worker の登録（中身ごと）
  .replace(/^.*\sdata-pwa[\s>].*$\n?/gm, '')                       // manifest / apple-touch-icon
  .replace('<link rel="stylesheet" href="assets/style.css">', `<style>\n${css}</style>`)
  .replace('<script src="assets/app.js"></script>', `<script>\n${js}</script>`);

const bodyIndex = process.argv.indexOf('--body');
if (bodyIndex > -1) {
  const out = process.argv[bodyIndex + 1];
  if (!out) throw new Error('--body には出力先のパスが必要です');
  const title = inlined.match(/<title>([\s\S]*?)<\/title>/)[1];
  const style = inlined.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = inlined.match(/<body>([\s\S]*)<\/body>/)[1].trim();
  // フォントと claude: 用のメタ情報も <head> から持っていく
  const extras = (inlined.match(/<meta name="claude:[^>]*>|<link rel="stylesheet" href="https:\/\/fonts[^>]*>/g) || []).join('\n');
  await writeFile(out, `<title>${title}</title>\n${extras}\n${style}\n\n${body}\n`);
  console.log(`${out} を書き出しました`);
} else {
  await writeFile(join(root, 'standalone.html'), inlined);
  console.log('standalone.html を書き出しました');
}
