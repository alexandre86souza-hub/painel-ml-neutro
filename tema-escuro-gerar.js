'use strict';
// node tema-escuro-gerar.js — gera public/tema-escuro-paginas.css: a versão ESCURA das cores fixas que
// cada tela tem no seu <style> (fundo branco, chip verde-claro, texto escuro…). Cada regra fica presa
// à tela dela (html[data-pagina="geral"], posto por public/tema.js), então uma classe com o mesmo nome
// em outra tela não é afetada. Rode de novo depois de mudar cores no <style> de uma tela
// (test-painel.js reprova se o arquivo estiver desatualizado).
// Mapa: fundo claro neutro -> vidro escuro; fundo claro colorido -> a mesma cor, translúcida;
// texto escuro -> claro (mesma cor, mais clara); borda clara -> linha do tema. Impressão e o
// papel da comanda (pré-visualização) ficam de fora.
const fs = require('node:fs');
const path = require('node:path');
const PUB = path.join(__dirname, 'public');
const SAIDA = path.join(PUB, 'tema-escuro-paginas.css');
const FORA = /\.comanda\b|\.c-[a-z]|@page|#previa\b|\.previa\b|\.etiqueta\b/;   // papel (fica claro, como impresso)

function rgbDe(txt) {
  const t = txt.trim().toLowerCase();
  if (t === 'white') return [255, 255, 255, 1];
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/.exec(t);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return null;
}
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const COR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|\bwhite\b/g;
const h0 = (x) => Math.round(x);

// Uma cor -> a versão escura, conforme o uso. null = não mexe.
function escura(txt, uso) {
  const c = rgbDe(txt); if (!c || c[3] === 0) return null;
  const [h, s, l] = hsl(c);
  if (uso === 'fundo') {
    if (l < 0.8) return null;                                     // já é escuro/forte (botão, marca)
    if (s < 0.2) return l >= 0.97 ? 'rgba(14,24,44,.72)' : 'rgba(125,211,252,.06)';
    return `hsla(${h0(h)},${h0(Math.min(s, 0.9) * 100)}%,60%,.14)`;
  }
  if (uso === 'texto') {
    if (l > 0.45) return null;
    if (s < 0.2) return l < 0.25 ? 'var(--ink)' : 'var(--muted)';
    return `hsl(${h0(h)},${h0(Math.min(s, 0.95) * 100)}%,72%)`;
  }
  if (uso === 'borda') {
    if (l < 0.72) return null;
    return s < 0.2 ? 'var(--line)' : `hsla(${h0(h)},${h0(Math.min(s, 0.9) * 100)}%,60%,.35)`;
  }
  return null;
}
const USO = (prop) => (/^background(-color|-image)?$/.test(prop) ? 'fundo' : prop === 'color' ? 'texto'
  : /^border(-(top|right|bottom|left))?(-color)?$/.test(prop) || prop === 'outline-color' ? 'borda' : null);

// Variáveis que o tema escuro já define (tema-escuro.css): a da página não é trocada.
const DO_TEMA = new Set(['--bg', '--card', '--raised', '--overlay', '--ink', '--muted', '--faint', '--line', '--softline',
  '--brand', '--ok', '--err', '--warn', '--grad']);
// Variável da página: o uso sai do nome (--ok-bg = fundo, --err-line = borda) ou da cor.
const usoDaVariavel = (nome, valor) => (/bg|fundo|card|claro|paper|surface/.test(nome) ? 'fundo' : /line|borda|border/.test(nome) ? 'borda'
  : (() => { const c = rgbDe(valor); return c && hsl(c)[2] > 0.6 ? 'fundo' : 'texto'; })());

// Declarações escuras de um bloco "prop:valor;…" (só as que mudam; !important é mantido).
function declaracoes(corpo) {
  const out = [];
  for (const d of corpo.split(';')) {
    const i = d.indexOf(':'); if (i < 0) continue;
    const prop = d.slice(0, i).trim(), valor = d.slice(i + 1).trim();
    const variavel = prop.startsWith('--');
    if (variavel && DO_TEMA.has(prop)) continue;
    const uso = variavel ? usoDaVariavel(prop, valor) : USO(prop.toLowerCase()); if (!uso) continue;
    let mudou = false;
    const novo = valor.replace(COR, (cor) => { const e = escura(cor, uso); if (e) { mudou = true; return e; } return cor; });
    if (mudou) out.push(`${prop}:${novo}`);
  }
  return out;
}

// Regras do CSS (sem @media print; @media de tela entram como estão).
function regras(css) {
  const lista = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  const ler = (fim, media) => {
    while (i < fim) {
      const ab = css.indexOf('{', i); if (ab < 0 || ab >= fim) return;
      const sel = css.slice(i, ab).trim();
      if (sel.startsWith('@')) {
        let n = 1, j = ab + 1; while (j < css.length && n) { if (css[j] === '{') n++; else if (css[j] === '}') n--; j++; }
        if (/^@media/.test(sel) && !/print/.test(sel)) { const ant = i; i = ab + 1; ler(j - 1, sel); i = j; void ant; } else i = j;
        continue;
      }
      const fe = css.indexOf('}', ab);
      lista.push({ sel, corpo: css.slice(ab + 1, fe), media }); i = fe + 1;
    }
  };
  ler(css.length, null);
  return lista;
}

function gerar() {
  const partes = ['/* GERADO por tema-escuro-gerar.js — não edite à mão (rode: node tema-escuro-gerar.js). */', '@media screen {'];
  for (const arq of fs.readdirSync(PUB).filter((f) => f.endsWith('.html')).sort()) {
    const html = fs.readFileSync(path.join(PUB, arq), 'utf8');
    const pag = arq.replace(/\.html$/, '');
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    const bloco = [];
    for (const r of regras(css)) {
      if (FORA.test(r.sel) || /^\*$/.test(r.sel) || /\bimg\b/.test(r.sel)) continue;   // logo e foto: fundo branco
      const ds = declaracoes(r.corpo); if (!ds.length) continue;
      const sel = /^:root$/.test(r.sel) ? `html[data-tema="escuro"][data-pagina="${pag}"]` : r.sel.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => `html[data-tema="escuro"][data-pagina="${pag}"] ${s.replace(/^(html|body)\b\s*/, '')}`.trim()).join(',\n');
      const linha = `${sel}{${ds.join(';')}}`;
      bloco.push(r.media ? `${r.media}{${linha}}` : linha);
    }
    if (bloco.length) partes.push(`/* ${arq} */`, ...bloco);
  }
  partes.push('}', '');
  return partes.join('\n');
}

if (require.main === module) { fs.writeFileSync(SAIDA, gerar()); console.log('gerado:', path.relative(__dirname, SAIDA)); }
module.exports = { gerar, escura, declaracoes, SAIDA };
