// ビルドが無い構成のための、最小限の構文チェック。
// api/・lib/の各.jsと、public/index.htmlのインラインJSをnode --checkで確認する。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const jsFiles = ['api', 'lib'].flatMap(dir =>
  readdirSync(join(root, dir)).filter(f => f.endsWith('.js')).map(f => join(root, dir, f))
);

let failed = false;
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`OK  ${file}`);
  } catch (err) {
    failed = true;
    console.error(`NG  ${file}\n${err.stderr}`);
  }
}

const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) {
  failed = true;
  console.error('NG  public/index.html: <script> が見つかりません');
} else {
  const tmp = join(mkdtempSync(join(tmpdir(), 'check-')), 'inline.js');
  writeFileSync(tmp, m[1]);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log('OK  public/index.html (inline script)');
  } catch (err) {
    failed = true;
    console.error(`NG  public/index.html (inline script)\n${err.stderr}`);
  }
}

if (failed) { console.error('\n構文エラーがあります'); process.exit(1); }
console.log('\n構文チェック: 問題なし');
