'use strict';
// Leitor mínimo de planilha .xlsx (só leitura, sem biblioteca): o arquivo é um ZIP com XML dentro.
// Lê o diretório central do ZIP, descompacta (deflate) só o que precisa — a lista de abas, os
// textos compartilhados e as abas — e devolve cada aba como linhas de valores. Fórmula vale o
// último resultado que o Excel gravou. Datas vêm como número de série do Excel (`dataDoExcel`).
// Usado na importação do estoque (estoque.js). Testado em test-estoque.js.
const zlib = require('node:zlib');

function arquivosDoZip(buf) {
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw Object.assign(new Error('Arquivo não é uma planilha .xlsx (ZIP inválido).'), { status: 400 });
  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const out = new Map();
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + nl);
    out.set(nome, () => {
      const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const dados = buf.subarray(ini, ini + comp);
      return (metodo === 8 ? zlib.inflateRawSync(dados) : dados).toString('utf8');
    });
    p += 46 + nl + el + cl;
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const texto = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const coluna = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// { abas: [nome…], aba(nome) -> linhas[][] } ; só lê a aba quando pedida.
function lerXlsx(buf) {
  const z = arquivosDoZip(buf);
  const ler = (n) => { const f = z.get(n); return f ? f() : null; };
  const comp = [];
  const ss = ler('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) comp.push(texto([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const wb = ler('xl/workbook.xml') || '';
  const rels = ler('xl/_rels/workbook.xml.rels') || '';
  const alvo = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const abas = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ nome: texto(/name="([^"]*)"/.exec(m[0])[1]),
    arq: 'xl/' + String(alvo.get(/r:id="([^"]+)"/.exec(m[0])?.[1]) || '').replace(/^\/?xl\//, '') }));
  return {
    abas: abas.map((a) => a.nome),
    aba(nome) {
      const a = abas.find((x) => x.nome === nome);
      const xml = a && ler(a.arq);
      if (!xml) return null;
      const linhas = [];
      for (const lm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(/\br="(\d+)"/.exec(lm[0])?.[1]) - 1;
        const linha = [];
        for (const cm of (lm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const at = cm[1], corpo = cm[2] || '';
          const ref = /\br="([A-Z]+\d+)"/.exec(at)?.[1];
          const t = /\bt="(\w+)"/.exec(at)?.[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
          let val = null;
          if (t === 's') val = v != null ? comp[Number(v)] ?? null : null;
          else if (t === 'inlineStr') val = texto([...corpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
          else if (t === 'str' || t === 'e') val = v != null ? texto(v) : null;
          else if (t === 'b') val = v === '1';
          else if (v != null) val = Number(v);
          if (ref) linha[coluna(ref)] = val;
        }
        if (r >= 0) linhas[r] = linha;
      }
      return linhas;
    },
  };
}

// Número de série do Excel (dias desde 30/12/1899) -> 'AAAA-MM-DD'.
const dataDoExcel = (n) => (typeof n === 'number' && n > 0 ? new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10) : null);

module.exports = { lerXlsx, dataDoExcel, arquivosDoZip };
