'use strict';
// node test-backup.js — cópia de segurança (backup.js): regra de guarda, cópia conferida e nome.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const B = require('./backup.js');

// ---------- nome <-> data ----------
const d = new Date('2026-10-02T15:30:00Z');
assert.strictEqual(B.nomeDe(d), 'painel-20261002-1530.sqlite');
assert.strictEqual(B.dataDoNome('painel-20261002-1530.sqlite').toISOString(), d.toISOString());
assert.strictEqual(B.dataDoNome('outro.sqlite'), null);

// ---------- guarda: 7 diárias, 1 por semana (8 semanas), 1 por mês (24 meses) ----------
const agora = Date.parse('2026-10-02T12:00:00Z');
const arqs = [];
for (let i = 0; i < 800; i++) {   // uma cópia por dia por 800 dias, duas no dia de hoje
  const dt = new Date(agora - i * 864e5);
  arqs.push({ nome: B.nomeDe(dt), data: dt });
}
arqs.push({ nome: B.nomeDe(new Date(agora - 3600e3)), data: new Date(agora - 3600e3) });
const apagar = new Set(B.paraApagar(arqs, agora));
const ficam = arqs.filter((a) => !apagar.has(a.nome));
assert.ok(ficam.some((a) => a.data.getTime() === agora), 'a mais nova fica');
assert.strictEqual(ficam.filter((a) => agora - a.data <= 7 * 864e5).length, 8, '7 dias = 8 datas diferentes (hoje e os 7 anteriores)');
assert.ok(ficam.length >= 8 + 6 + 20 && ficam.length <= 8 + 9 + 25, `guarda razoável (${ficam.length})`);
assert.ok(ficam.every((a) => agora - a.data <= 731 * 864e5), 'nada com mais de 2 anos');
assert.deepStrictEqual(B.paraApagar([], agora), []);

// ---------- cópia real de um banco em uso (WAL), conferida ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-backup-'));
const banco = path.join(dir, 'dados.sqlite');
const db = new DatabaseSync(banco);
db.exec("PRAGMA journal_mode = WAL; CREATE TABLE vendas (order_id INTEGER); INSERT INTO vendas VALUES (1),(2),(3); CREATE TABLE estado (chave TEXT PRIMARY KEY, valor TEXT)");
const pasta = path.join(dir, 'copias');
const r = B.fazer(db, pasta);
assert.strictEqual(r.vendas, 3);
assert.ok(fs.existsSync(r.arquivo) && !fs.existsSync(r.arquivo + '.parcial'));
const c = new DatabaseSync(r.arquivo, { readOnly: true });
assert.strictEqual(c.prepare('SELECT COUNT(*) n FROM vendas').get().n, 3, 'a cópia tem os dados');
c.close();
assert.strictEqual(B.listar(pasta).length, 1);
// dentro do painel: a pasta vem do estado; GET mostra a cópia
const D = { db, configLer: (k) => db.prepare('SELECT valor FROM estado WHERE chave=?').get(k)?.valor ?? null,
  configGravar: (k, v) => db.prepare('INSERT INTO estado (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(k, v) };
D.configGravar('backup_pasta', pasta);
const m = B.criar({ D });
(async () => {
  const feito = await m.rotas['POST /api/backup']();
  assert.strictEqual(feito.vendas, 3);
  const st = await m.rotas['GET /api/backup']();
  assert.strictEqual(st.pasta, pasta);
  assert.ok(st.ultimo && st.copias.length >= 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Cópia de segurança: nome, regra de guarda, cópia conferida com o banco em uso: ok');
})().catch((e) => { console.error(e); process.exit(1); });
