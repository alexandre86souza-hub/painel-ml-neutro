#!/usr/bin/env node
'use strict';
// npm run setup — deixa o projeto pronto para o "npm start". Pode rodar quantas vezes
// quiser: cada passo confere antes de fazer.
//   1. Node 22.13+                       (não instala: avisa como)
//   2. dependências Node (cloudflared)   npm install
//   3. uv                                instalador oficial da Astral, se faltar
//   4. Python + dependências do scraper  uv sync (o uv baixa o Python 3.12 se preciso)
//   5. Chromium do Playwright            playwright install chromium
//   6. .env com chave de cifra nova      ambiente.js
//   7. testes                            npm test
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = __dirname;
const SCRAPER = path.join(RAIZ, 'scraper');
const WIN = process.platform === 'win32';
const resultado = [];
const ok = (t) => { resultado.push(`[ok] ${t}`); console.log(`  [ok] ${t}`); };
const falhou = (t, dica) => { resultado.push(`[x]  ${t}${dica ? `\n       ${dica}` : ''}`); console.log(`  [x]  ${t}`); if (dica) console.log(`       ${dica}`); };
const etapa = (t) => console.log(`\n> ${t}`);

function rodar(cmd, args, opts = {}) {
  console.log(`  $ ${[path.basename(cmd), ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: opts.shell ?? false, cwd: opts.cwd || RAIZ, env: { ...process.env, ...opts.env } });
  return r.status === 0;
}

console.log('\nAula Mercado Livre - Henrique Niada — instalação\n');

// 1. Node
etapa('Node.js');
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior < 22 || (maior === 22 && menor < 13)) {
  falhou(`Node ${process.versions.node} (precisa 22.13 ou mais novo)`,
    WIN ? 'Instale com: winget install OpenJS.NodeJS.LTS   e abra um terminal novo.'
      : 'Instale o Node LTS: https://nodejs.org  (no Mac: brew install node)');
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. npm install
etapa('Dependências Node');
const cfPkg = path.join(RAIZ, 'node_modules', 'cloudflared', 'package.json');
if (!fs.existsSync(cfPkg) && !rodar('npm', ['install', '--no-audit', '--no-fund'], { shell: WIN })) {
  falhou('npm install falhou', 'Veja o erro acima. Sem internet? Tente de novo.');
  process.exit(1);
}
ok('npm install');

// o binário do cloudflared costuma vir no postinstall; se não veio, baixa agora
etapa('cloudflared (túnel HTTPS)');
try {
  const cf = require('cloudflared');
  if (!fs.existsSync(cf.bin)) {
    console.log('  baixando o binário…');
    const r = spawnSync(process.execPath, ['-e', 'require("cloudflared").install(require("cloudflared").bin).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})'],
      { stdio: 'inherit', cwd: RAIZ });
    if (r.status !== 0) throw new Error('download falhou');
  }
  ok(`cloudflared em ${path.relative(RAIZ, cf.bin)}`);
} catch (e) {
  falhou(`cloudflared: ${e.message}`, 'O npm start ainda tenta o localtunnel como reserva.');
}

// 3. uv
etapa('uv (gerenciador do Python)');
const { acharUv } = require('./processos.js');
let uv = acharUv();
if (!uv) {
  console.log('  uv não encontrado — instalando pelo instalador oficial (astral.sh)…');
  if (WIN) rodar('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex']);
  else rodar('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
  uv = acharUv();
}
if (!uv) {
  falhou('uv não instalado', 'Instale manualmente: https://docs.astral.sh/uv/getting-started/installation/ e rode npm run setup de novo.');
} else {
  const v = spawnSync(uv, ['--version'], { encoding: 'utf8' });
  ok(`${String(v.stdout).trim()} (${uv})`);

  // 4. dependências Python
  etapa('Scraper: Python e dependências');
  if (rodar(uv, ['sync', '--frozen'], { cwd: SCRAPER })) ok('uv sync');
  else falhou('uv sync falhou', 'Veja o erro acima.');

  // 5. Chromium
  etapa('Scraper: navegador Chromium (Playwright)');
  if (rodar(uv, ['run', '--frozen', 'playwright', 'install', 'chromium'], { cwd: SCRAPER })) ok('Chromium instalado');
  else {
    falhou('playwright install falhou', process.platform === 'linux'
      ? 'No Linux, instale as dependências do sistema: cd scraper && sudo $(which uv) run playwright install-deps chromium'
      : 'Veja o erro acima e rode npm run setup de novo.');
  }
}

// 6. .env
etapa('Configuração local');
const { criado } = require('./ambiente.js').carregar();
ok(criado ? '.env criado com uma chave de cifra nova' : '.env já existia (mantido)');
require('./db.js');
ok('banco SQLite pronto');

// 7. testes
etapa('Testes');
if (rodar('npm', ['test', '--silent'], { shell: WIN, env: { ABRIR_NAVEGADOR: '0' } })) ok('testes passaram');
else falhou('algum teste falhou', 'Veja a saída acima.');

console.log('\nResumo:\n' + resultado.map((r) => `  ${r}`).join('\n'));
const erros = resultado.filter((r) => r.startsWith('[x]')).length;
console.log(erros
  ? `\n${erros} item(ns) com problema. Corrija e rode "npm run setup" de novo.\n`
  : '\nTudo pronto. Agora rode:  npm start\n');
process.exit(erros ? 1 : 0);
