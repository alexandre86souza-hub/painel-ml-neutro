'use strict';
// Cópia de segurança do painel: TUDO mora em dados.sqlite (vendas, pagamentos, custos, métricas,
// configurações). O painel copia o banco sozinho uma vez por dia (server.js chama `agendar`);
// `npm run backup` copia na hora e `npm run restaurar` volta uma cópia.
//
// - Cópia íntegra com o painel ligado: VACUUM INTO (o SQLite lê um retrato consistente, mesmo com
//   o modo WAL gravando), depois aberta de novo e conferida (quick_check + contagem de vendas).
// - Guarda: as 7 últimas diárias, 1 por semana por 8 semanas e 1 por mês por 24 meses.
// - Pasta: `backup_pasta` (estado), definida SÓ pelo comando no computador
//   (`npm run backup -- --pasta "C:\...\OneDrive\Painel"`): pela porta pública ninguém escolhe
//   onde gravar arquivos. Sem ela: <projeto>/backups (fora do git).
// - Os segredos (tokens, chave do app) vão cifrados com a ML_DB_KEY do .env, que NÃO entra na
//   cópia: restaurar em outro computador sem ela = reconectar as contas (os dados ficam).
const fs = require('fs');
const path = require('path');

const PREFIXO = 'painel-';
const pastaPadrao = () => path.resolve(__dirname, 'backups');
const nomeDe = (d) => `${PREFIXO}${d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.sqlite`;   // painel-20261002-1530.sqlite
const dataDoNome = (nome) => {
  const m = /^painel-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.sqlite$/.exec(nome);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
};

// Quais cópias apagar (função pura: testada). arquivos = [{ nome, data }].
function paraApagar(arquivos, agora = Date.now()) {
  const ord = [...arquivos].filter((a) => a.data).sort((a, b) => b.data - a.data);
  const fica = new Set();
  const dia = (d) => d.toISOString().slice(0, 10);
  const semana = (d) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return dia(x); };
  const mes = (d) => d.toISOString().slice(0, 7);
  const vistos = { d: new Set(), s: new Set(), m: new Set() };
  for (const a of ord) {
    const idade = (agora - a.data) / 864e5;
    if (idade <= 7 && !vistos.d.has(dia(a.data))) { vistos.d.add(dia(a.data)); fica.add(a.nome); }
    if (idade <= 56 && !vistos.s.has(semana(a.data))) { vistos.s.add(semana(a.data)); fica.add(a.nome); }
    if (idade <= 730 && !vistos.m.has(mes(a.data))) { vistos.m.add(mes(a.data)); fica.add(a.nome); }
  }
  if (ord[0]) fica.add(ord[0].nome);   // a mais nova nunca sai
  return ord.filter((a) => !fica.has(a.nome)).map((a) => a.nome);
}

function listar(pasta) {
  let nomes = [];
  try { nomes = fs.readdirSync(pasta); } catch { return []; }
  return nomes.map((nome) => ({ nome, data: dataDoNome(nome) })).filter((a) => a.data)
    .map((a) => ({ ...a, tamanho: fs.statSync(path.join(pasta, a.nome)).size })).sort((a, b) => b.data - a.data);
}

// Copia o banco aberto (`db`, node:sqlite) para a pasta, confere e apaga as que sobram.
function fazer(db, pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const agora = new Date();
  const final = path.join(pasta, nomeDe(agora));
  const tmp = final + '.parcial';
  try { fs.unlinkSync(tmp); } catch {}
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  // confere a cópia antes de dar o nome final
  const { DatabaseSync } = require('node:sqlite');
  const c = new DatabaseSync(tmp, { readOnly: true });
  let vendas;
  try {
    const ok = c.prepare('PRAGMA quick_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('a cópia não passou na conferência do SQLite');
    vendas = c.prepare('SELECT COUNT(*) AS n FROM vendas').get().n;
  } finally { c.close(); }
  try { fs.unlinkSync(final); } catch {}
  fs.renameSync(tmp, final);
  const apagadas = paraApagar(listar(pasta), agora.getTime());
  for (const nome of apagadas) { try { fs.unlinkSync(path.join(pasta, nome)); } catch {} }
  return { arquivo: final, tamanho: fs.statSync(final).size, vendas, em: agora.toISOString(), apagadas };
}

// Dentro do painel: rotas da tela Configuração e a cópia diária automática.
function criar({ D }) {
  const pasta = () => D.configLer('backup_pasta') || pastaPadrao();
  let fazendo = false;
  function agora() {
    if (fazendo) throw Object.assign(new Error('Já tem uma cópia em andamento.'), { status: 409 });
    fazendo = true;
    try {
      const r = fazer(D.db, pasta());
      D.configGravar('backup_ultimo', JSON.stringify({ em: r.em, arquivo: r.arquivo, tamanho: r.tamanho, vendas: r.vendas }));
      D.configGravar('backup_erro', null);
      return r;
    } catch (e) {
      D.configGravar('backup_erro', JSON.stringify({ em: new Date().toISOString(), erro: e.message }));
      throw e;
    } finally { fazendo = false; }
  }
  // confere de hora em hora; copia se a última tem mais de 24 h (1ª: 2 min depois de ligar)
  function agendar() {
    const ver = () => {
      let ult = null; try { ult = JSON.parse(D.configLer('backup_ultimo') || 'null'); } catch {}
      if (!ult || Date.now() - Date.parse(ult.em) > 24 * 3600e3) { try { agora(); } catch {} }
    };
    setTimeout(ver, 2 * 60e3).unref?.();
    setInterval(ver, 3600e3).unref?.();
  }
  const json = (k) => { try { return JSON.parse(D.configLer(k) || 'null'); } catch { return null; } };
  const rotas = {
    'GET /api/backup': async () => {
      const p = pasta();
      return { pasta: p, padrao: p === pastaPadrao(), ultimo: json('backup_ultimo'), erro: json('backup_erro'),
        copias: listar(p).map((a) => ({ nome: a.nome, data: a.data.toISOString(), tamanho: a.tamanho })) };
    },
    'POST /api/backup': async () => {
      const r = agora();
      return { ok: true, arquivo: path.basename(r.arquivo), tamanho: r.tamanho, vendas: r.vendas, em: r.em };
    },
  };
  return { rotas, agendar, agora };
}

module.exports = { criar, fazer, listar, paraApagar, nomeDe, dataDoNome, pastaPadrao };

// ---------- linha de comando ----------
// npm run backup                       -> copia agora (na pasta configurada)
// npm run backup -- --pasta "C:\X"     -> grava a pasta e copia agora
// npm run restaurar -- painel-....sqlite  -> volta a cópia (com o painel PARADO)
if (require.main === module) {
  (async () => {
    require('./ambiente.js').carregar();
    const args = process.argv.slice(2);
    const D = require('./db.js');
    if (args[0] === 'restaurar') {
      const alvo = args[1];
      if (!alvo) { console.log('Use: npm run restaurar -- <arquivo da cópia>'); process.exit(1); }
      const pastaCfg = D.configLer('backup_pasta') || pastaPadrao();
      const arq = fs.existsSync(alvo) ? path.resolve(alvo) : path.join(pastaCfg, alvo);
      if (!fs.existsSync(arq)) { console.log('Não achei a cópia:', arq); process.exit(1); }
      // painel ligado = banco em uso: recusa
      const porta = Number(process.env.PORTA_PAINEL || process.env.PORT || 3100);
      const ligado = await new Promise((r) => { const s = require('net').connect(porta, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
      if (ligado) { console.log(`O painel está ligado (porta ${porta}). Pare com Ctrl+C e rode de novo.`); process.exit(1); }
      D.db.close();
      const banco = D.DB_FILE;
      const guardado = `${banco}.antes-restaurar-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}`;
      fs.renameSync(banco, guardado);
      for (const x of ['-wal', '-shm']) { try { fs.renameSync(banco + x, guardado + x); } catch {} }
      fs.copyFileSync(arq, banco);
      console.log(`Restaurado: ${path.basename(arq)}\nO banco anterior ficou em: ${guardado}\nLigue o painel com npm start.`);
      process.exit(0);
    }
    const i = args.indexOf('--pasta');
    if (i >= 0) {
      const p = path.resolve(args[i + 1] || '');
      if (!args[i + 1]) { console.log('Use: npm run backup -- --pasta "C:\\caminho\\da\\pasta"'); process.exit(1); }
      fs.mkdirSync(p, { recursive: true });
      D.configGravar('backup_pasta', p);
      console.log('Pasta das cópias:', p);
    }
    const b = criar({ D });
    const r = b.agora();
    console.log(`Cópia feita e conferida: ${r.arquivo}\n${(r.tamanho / 1048576).toFixed(1)} MB · ${r.vendas} linhas de venda` +
      (r.apagadas.length ? `\nCópias antigas apagadas pela regra de guarda: ${r.apagadas.length}` : ''));
    process.exit(0);
  })().catch((e) => { console.log('Falhou:', e.message); process.exit(1); });
}
