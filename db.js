'use strict';
// Banco SQLite (node:sqlite, nativo do Node 22.5+). Guarda contas do Mercado Livre,
// produtos publicados e notificações de webhook.
//
// Tokens vão CIFRADOS (AES-256-GCM) com a chave de ML_DB_KEY. São credenciais de
// vendedores reais num servidor exposto à internet — o arquivo do banco vaza em
// backup, snapshot de volume ou cópia errada, e sem cifra isso entrega as contas.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Relativo à pasta do projeto, não à pasta de onde o comando foi rodado.
const DB_FILE = path.resolve(__dirname, process.env.ML_DB_FILE || 'dados.sqlite');
const CHAVE = process.env.ML_DB_KEY
  ? crypto.createHash('sha256').update(process.env.ML_DB_KEY).digest()
  : null;

if (!CHAVE) {
  console.warn('[db] ML_DB_KEY não definida — tokens serão gravados EM CLARO. '
    + 'Gere uma com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

function cifrar(txt) {
  if (txt == null) return null;
  if (!CHAVE) return String(txt);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CHAVE, iv);
  const ct = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decifrar(txt) {
  if (txt == null) return null;
  if (!String(txt).startsWith('v1:')) return String(txt); // gravado antes da chave existir
  if (!CHAVE) throw new Error('Banco tem tokens cifrados mas ML_DB_KEY não está definida.');
  const [, iv, tag, ct] = String(txt).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', CHAVE, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const db = new DatabaseSync(DB_FILE);
try { fs.chmodSync(DB_FILE, 0o600); } catch {}
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Dois processos escrevem neste banco: o painel (npm start) e o servidor MCP (mcp.js).
// Com WAL a leitura nunca trava, mas duas escritas ao mesmo tempo dariam SQLITE_BUSY na hora.
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS contas (
    ml_user_id    INTEGER PRIMARY KEY,
    nickname      TEXT,
    site_id       TEXT,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    INTEGER NOT NULL,
    scope         TEXT,
    conectada_em  TEXT NOT NULL,
    atualizada_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS estado (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );
  CREATE TABLE IF NOT EXISTS produtos (
    item_id     TEXT PRIMARY KEY,
    ml_user_id  INTEGER NOT NULL,
    title       TEXT,
    category_id TEXT,
    price       REAL,
    quantidade  INTEGER,
    status      TEXT,
    permalink   TEXT,
    payload     TEXT,
    criado_em   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_produtos_conta ON produtos(ml_user_id, criado_em DESC);
  CREATE TABLE IF NOT EXISTS notificacoes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    recebida_em    TEXT NOT NULL,
    topic          TEXT,
    resource       TEXT,
    ml_user_id     INTEGER,
    application_id TEXT,
    attempts       INTEGER,
    payload        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notif_conta ON notificacoes(ml_user_id, id DESC);
`);

const agora = () => new Date().toISOString();

// ---------- contas ----------
function contaSalvar(tokens, perfil) {
  const id = perfil.id;
  db.prepare(`
    INSERT INTO contas (ml_user_id, nickname, site_id, access_token, refresh_token,
                        expires_at, scope, conectada_em, atualizada_em)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ml_user_id) DO UPDATE SET
      nickname=excluded.nickname, site_id=excluded.site_id,
      access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at, scope=excluded.scope,
      atualizada_em=excluded.atualizada_em
  `).run(id, perfil.nickname || null, perfil.site_id || null,
    cifrar(tokens.access_token), cifrar(tokens.refresh_token),
    Date.now() + (tokens.expires_in - 60) * 1000, tokens.scope || null, agora(), agora());
  if (!contaAtivaId()) contaAtivaDefinir(id);
  return id;
}

function contaTokensAtualizar(id, tokens) {
  db.prepare(`UPDATE contas SET access_token=?, refresh_token=?, expires_at=?, atualizada_em=?
              WHERE ml_user_id=?`)
    .run(cifrar(tokens.access_token), cifrar(tokens.refresh_token),
      Date.now() + (tokens.expires_in - 60) * 1000, agora(), id);
}

function contaObter(id) {
  const c = db.prepare('SELECT * FROM contas WHERE ml_user_id = ?').get(id);
  if (!c) return null;
  return { ...c, access_token: decifrar(c.access_token), refresh_token: decifrar(c.refresh_token) };
}

// Nunca devolve token — é o que vai para o browser.
function contasListar() {
  return db.prepare(`SELECT ml_user_id, nickname, site_id, expires_at, conectada_em,
                            (SELECT COUNT(*) FROM produtos p WHERE p.ml_user_id = c.ml_user_id) AS produtos
                     FROM contas c ORDER BY conectada_em`).all();
}

const contaAtivaId = () =>
  db.prepare("SELECT valor FROM estado WHERE chave='conta_ativa'").get()?.valor ?? null;

function contaAtivaDefinir(id) {
  if (id !== null && !db.prepare('SELECT 1 FROM contas WHERE ml_user_id=?').get(id)) {
    throw Object.assign(new Error('conta não conectada'), { status: 404 });
  }
  db.prepare(`INSERT INTO estado (chave, valor) VALUES ('conta_ativa', ?)
              ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor`).run(id === null ? null : String(id));
}

const contaAtiva = () => { const id = contaAtivaId(); return id ? contaObter(Number(id)) : null; };

function contaRemover(id) {
  db.prepare('DELETE FROM contas WHERE ml_user_id=?').run(id);
  if (String(contaAtivaId()) === String(id)) {
    contaAtivaDefinir(db.prepare('SELECT ml_user_id FROM contas LIMIT 1').get()?.ml_user_id ?? null);
  }
}

// ---------- produtos ----------
function produtoSalvar(mlUserId, item, payload) {
  db.prepare(`INSERT INTO produtos (item_id, ml_user_id, title, category_id, price, quantidade,
                                    status, permalink, payload, criado_em)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET status=excluded.status, price=excluded.price,
                                                 quantidade=excluded.quantidade`)
    .run(item.id, mlUserId, payload.title, payload.category_id, payload.price,
      payload.available_quantity, item.status || null, item.permalink || null,
      JSON.stringify(payload), agora());
}
const produtosListar = (mlUserId, limite = 50) =>
  db.prepare(`SELECT item_id, title, price, quantidade, status, permalink, criado_em
              FROM produtos WHERE ml_user_id=? ORDER BY criado_em DESC LIMIT ?`).all(mlUserId, limite);


// Espelha o anúncio como o ML o devolve (listagem/edição), sem exigir o payload de criação.
function produtoSincronizar(mlUserId, it) {
  db.prepare(`INSERT INTO produtos (item_id, ml_user_id, title, category_id, price, quantidade,
                                    status, permalink, payload, criado_em)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET
                title=excluded.title, category_id=excluded.category_id, price=excluded.price,
                quantidade=excluded.quantidade, status=excluded.status, permalink=excluded.permalink,
                payload=excluded.payload`)
    .run(it.id, mlUserId, it.title ?? null, it.category_id ?? null,
      it.price ?? null, it.available_quantity ?? null, it.status ?? null,
      it.permalink ?? null, JSON.stringify(it), agora());
}

// ---------- notificações ----------
function notificacaoSalvar(nota, cru) {
  db.prepare(`INSERT INTO notificacoes (recebida_em, topic, resource, ml_user_id,
                                        application_id, attempts, payload)
              VALUES (?,?,?,?,?,?,?)`)
    .run(agora(), nota?.topic ?? null, nota?.resource ?? null,
      Number.isInteger(nota?.user_id) ? nota.user_id : null,
      nota?.application_id != null ? String(nota.application_id) : null,
      Number.isInteger(nota?.attempts) ? nota.attempts : null, cru.slice(0, 20000));
}
const notificacoesListar = (limite = 50) =>
  db.prepare(`SELECT id, recebida_em, topic, resource, ml_user_id, attempts
              FROM notificacoes ORDER BY id DESC LIMIT ?`).all(limite);


// ---------- palavras-chave e posição na listagem ----------
// A posição não vem da API oficial (o /sites/search responde 403): quem mede é o
// scraper local. Guardamos histórico para dar para ver se o anúncio sobe ou desce.
db.exec(`
  CREATE TABLE IF NOT EXISTS palavras (
    item_id    TEXT NOT NULL,
    ml_user_id INTEGER NOT NULL,
    termo      TEXT NOT NULL,
    criada_em  TEXT NOT NULL,
    PRIMARY KEY (item_id, termo)
  );
  CREATE TABLE IF NOT EXISTS posicoes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id            TEXT NOT NULL,
    termo              TEXT NOT NULL,
    medida_em          TEXT NOT NULL,
    posicao            INTEGER,
    patrocinados_acima INTEGER,
    total              INTEGER,
    preco              REAL,
    vizinhos           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_posicoes ON posicoes(item_id, termo, id DESC);
`);

// Versão da medição. v1 (até 18/09/2026) contava a posição a partir de 0, incluía banners
// e às vezes lia preço/posição do anúncio vizinho. Fica gravada para auditoria, mas não
// entra na tela nem na variação: comparar v1 com v2 mostraria um "caiu" que não houve.
const VERSAO_POSICAO = 2;
const colunasPosicoes = db.prepare('PRAGMA table_info(posicoes)').all().map((c) => c.name);
if (!colunasPosicoes.includes('versao')) {
  db.exec('ALTER TABLE posicoes ADD COLUMN versao INTEGER NOT NULL DEFAULT 1');
}
// Outros anúncios do mesmo vendedor que apareceram na busca. O ML costuma mostrar só um
// anúncio por vendedor para o mesmo produto: sem isto, "não encontrado" parecia defeito.
if (!colunasPosicoes.includes('meus')) db.exec('ALTER TABLE posicoes ADD COLUMN meus TEXT');
// A lista inteira da busca (~60 anúncios de todos os vendedores, ~25 KB), para comparar
// preço e posição com qualquer concorrente, não só com os vizinhos.
if (!colunasPosicoes.includes('lista')) db.exec('ALTER TABLE posicoes ADD COLUMN lista TEXT');

const palavraAdicionar = (itemId, mlUserId, termo) =>
  db.prepare(`INSERT INTO palavras (item_id, ml_user_id, termo, criada_em) VALUES (?,?,?,?)
              ON CONFLICT(item_id, termo) DO NOTHING`).run(itemId, mlUserId, termo, agora());

const palavraRemover = (itemId, termo) =>
  db.prepare('DELETE FROM palavras WHERE item_id=? AND termo=?').run(itemId, termo);

// Cada termo já vem com a última medição e a anterior, para mostrar a variação.
function palavrasListar(itemId) {
  return db.prepare('SELECT termo FROM palavras WHERE item_id=? ORDER BY criada_em').all(itemId)
    .map(({ termo }) => {
      const hist = db.prepare(`SELECT posicao, patrocinados_acima, total, medida_em, vizinhos, meus, lista
                               FROM posicoes WHERE item_id=? AND termo=? AND versao=?
                               ORDER BY id DESC LIMIT 2`)
        .all(itemId, termo, VERSAO_POSICAO);
      const [atual, anterior] = hist;
      return {
        termo,
        posicao: atual?.posicao ?? null,
        patrocinados_acima: atual?.patrocinados_acima ?? null,
        total: atual?.total ?? null,
        medida_em: atual?.medida_em ?? null,
        // negativo = subiu na listagem (posição menor é melhor)
        variacao: atual?.posicao != null && anterior?.posicao != null
          ? atual.posicao - anterior.posicao : null,
        vizinhos: atual?.vizinhos ? JSON.parse(atual.vizinhos) : [],
        meus: atual?.meus ? JSON.parse(atual.meus) : null,  // null = não foi possível checar
        lista: atual?.lista ? JSON.parse(atual.lista) : null, // null = medição anterior à lista
      };
    });
}

const posicaoSalvar = (itemId, termo, r) =>
  db.prepare(`INSERT INTO posicoes (item_id, termo, medida_em, posicao, patrocinados_acima,
                                    total, preco, vizinhos, versao, meus, lista)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(itemId, termo, agora(), r.posicao ?? null, r.patrocinados_acima ?? null,
      r.total_na_pagina ?? null, r.preco ?? null, JSON.stringify(r.vizinhos || []), VERSAO_POSICAO,
      r.meus ? JSON.stringify(r.meus) : null, r.lista ? JSON.stringify(r.lista) : null);

const posicoesHistorico = (itemId, termo, limite = 30) =>
  db.prepare(`SELECT medida_em, posicao FROM posicoes WHERE item_id=? AND termo=? AND versao=?
              ORDER BY id DESC LIMIT ?`).all(itemId, termo, VERSAO_POSICAO, limite).reverse();

// ---------- custos, vendas e frete (lucro real) ----------
// custos: o que só o vendedor sabe (quanto pagou no produto). Por unidade.
// vendas: cópia local das linhas de pedido. Uma conta real tinha 11 mil pedidos em 150 dias;
//   buscar tudo a cada tela custaria ~220 chamadas ao ML. Aqui o período vira SQL.
// fretes: o custo de envio que o ML cobrou do vendedor, por envio. Não muda depois do
//   envio, então fica guardado e cada envio é consultado uma vez só.
db.exec(`
  CREATE TABLE IF NOT EXISTS custos (
    item_id       TEXT PRIMARY KEY,
    ml_user_id    INTEGER NOT NULL,
    custo         REAL,
    outros        REAL,
    atualizado_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vendas (
    order_id    INTEGER NOT NULL,
    item_id     TEXT NOT NULL,
    variacao    INTEGER NOT NULL DEFAULT 0,
    ml_user_id  INTEGER NOT NULL,
    data        TEXT NOT NULL,
    status      TEXT,
    quantidade  INTEGER NOT NULL,
    preco_unit  REAL NOT NULL,
    tarifa_unit REAL,
    envio_id    INTEGER,
    PRIMARY KEY (order_id, item_id, variacao)
  );
  CREATE INDEX IF NOT EXISTS idx_vendas_conta_data ON vendas(ml_user_id, data);
  CREATE INDEX IF NOT EXISTS idx_vendas_item_data ON vendas(item_id, data);
  CREATE TABLE IF NOT EXISTS fretes (
    envio_id   INTEGER PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    custo      REAL NOT NULL,
    medido_em  TEXT NOT NULL
  );
`);

// Colunas acrescentadas depois: banco de quem já usava o painel não tem. ADD COLUMN em
// coluna que já existe dá erro, e é esse erro que se ignora.
const colunaNova = (tabela, def) => { try { db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${def}`); } catch {} };
// custos.origem: 'sku' = calculado pela tabela de produtos (recalculado a cada importação);
// 'manual' = digitado na tela (a tabela não passa por cima). outros = embalagem e afins.
colunaNova('custos', 'origem TEXT');
// custos.extra: outro custo por unidade do anúncio (etiqueta, brinde, mão de obra…), somado
// à embalagem. `outros` segue sendo a embalagem (NULL = embalagem padrão da empresa).
colunaNova('custos', 'extra REAL');
// vendas.sku: o SKU da unidade vendida, direto do pedido — com variação, é o SKU dela.
colunaNova('vendas', 'sku TEXT');
// vendas.origem: de qual estoque a unidade saiu (order_items[].stock.node_id). Medido em
// 29/09/2026: "BRP1234567891" = depósito do vendedor; "BRSP04", "BRSP02"… = armazém do ML (Full).
colunaNova('vendas', 'origem TEXT');

function custoGravar(mlUserId, itemId, { custo, outros }) {
  db.prepare(`INSERT INTO custos (item_id, ml_user_id, custo, outros, atualizado_em, origem) VALUES (?,?,?,?,?,'manual')
              ON CONFLICT(item_id) DO UPDATE SET custo=excluded.custo, outros=excluded.outros,
                                                 atualizado_em=excluded.atualizado_em, origem='manual'`)
    .run(itemId, mlUserId, custo ?? null, outros ?? null, agora());
}
// Custo vindo do SKU: não pisa em custo digitado à mão nem mexe na embalagem (outros).
function custoAutoGravar(mlUserId, itemId, custo) {
  db.prepare(`INSERT INTO custos (item_id, ml_user_id, custo, outros, atualizado_em, origem) VALUES (?,?,?,NULL,?,'sku')
              ON CONFLICT(item_id) DO UPDATE SET custo=excluded.custo, atualizado_em=excluded.atualizado_em,
                                                 origem='sku'
              WHERE custos.origem IS NULL OR custos.origem='sku' OR custos.custo IS NULL`)
    .run(itemId, mlUserId, custo ?? null, agora());
}
// Só a embalagem (outros por unidade), sem tocar no custo do produto.
function embalagemGravar(mlUserId, itemId, valor) {
  db.prepare(`INSERT INTO custos (item_id, ml_user_id, custo, outros, atualizado_em, origem) VALUES (?,?,NULL,?,?,NULL)
              ON CONFLICT(item_id) DO UPDATE SET outros=excluded.outros, atualizado_em=excluded.atualizado_em`)
    .run(itemId, mlUserId, valor ?? null, agora());
}
// Outro custo por unidade (custos.extra), sem tocar no custo do produto nem na embalagem.
function extraGravar(mlUserId, itemId, valor) {
  db.prepare(`INSERT INTO custos (item_id, ml_user_id, custo, outros, extra, atualizado_em, origem) VALUES (?,?,NULL,NULL,?,?,NULL)
              ON CONFLICT(item_id) DO UPDATE SET extra=excluded.extra, atualizado_em=excluded.atualizado_em`)
    .run(itemId, mlUserId, valor ?? null, agora());
}
const custoObter = (itemId) =>
  db.prepare('SELECT custo, outros, extra, origem, atualizado_em FROM custos WHERE item_id=?').get(itemId) ?? null;
function custosDe(ids) {
  if (!ids.length) return {};
  return Object.fromEntries(db.prepare(`SELECT item_id, custo, outros, extra, origem FROM custos
                                        WHERE item_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map((r) => [r.item_id, { custo: r.custo, outros: r.outros, extra: r.extra, origem: r.origem,
      // embalagem + outro custo, para as contas que não usam a embalagem padrão da empresa
      outros_total: r.outros == null && r.extra == null ? null : (r.outros || 0) + (r.extra || 0) }]));
}

// ---------- tabela de produtos (custo por SKU de componente) ----------
// O SKU do anúncio junta componentes: KIT-407.408 = produto 407 (DQ-407) + produto 408
// (BP-408). O número é a chave; o prefixo (DQ, BP…) só descreve.
db.exec(`
  CREATE TABLE IF NOT EXISTS produtos_custo (
    numero        INTEGER PRIMARY KEY,
    sku           TEXT,
    nome          TEXT,
    custo         REAL,
    situacao      TEXT,
    fornecedor    TEXT,
    atualizado_em TEXT NOT NULL
  );
`);
function catalogoGravar(linhas) {
  const st = db.prepare(`INSERT OR REPLACE INTO produtos_custo (numero, sku, nome, custo, situacao, fornecedor, atualizado_em)
                         VALUES (?,?,?,?,?,?,?)`);
  const em = agora();
  db.exec('BEGIN');
  try {
    for (const l of linhas) st.run(l.numero, l.sku ?? null, l.nome ?? null, l.custo ?? null, l.situacao ?? null, l.fornecedor ?? null, em);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const catalogoListar = () => db.prepare('SELECT * FROM produtos_custo ORDER BY numero').all();
const catalogoResumo = () => db.prepare(`SELECT COUNT(*) AS produtos, SUM(custo IS NULL) AS sem_custo,
                                                MAX(atualizado_em) AS atualizado_em FROM produtos_custo`).get();

// Imposto é da empresa (Simples, Lucro Presumido…), não do anúncio: um valor por conta.
const impostoLer = (mlUserId) => {
  const v = configLer(`imposto_pct:${mlUserId}`);
  return v == null ? null : Number(v);
};
const impostoGravar = (mlUserId, pct) => configGravar(`imposto_pct:${mlUserId}`, pct == null ? null : String(pct));

// Pedido cancelado ou inválido não é venda; "confirmed" ainda não foi pago (e é também
// como a API mostra a venda que o vendedor marcou como não concretizada).
const STATUS_VENDA = ['paid', 'partially_refunded'];
const EM_VENDA = `status IN (${STATUS_VENDA.map((s) => `'${s}'`).join(',')})`;

function vendasGravar(linhas) {
  const st = db.prepare(`INSERT INTO vendas (order_id, item_id, variacao, ml_user_id, data, status,
                                             quantidade, preco_unit, tarifa_unit, envio_id, sku, origem)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(order_id, item_id, variacao) DO UPDATE SET
                           status=excluded.status, quantidade=excluded.quantidade,
                           preco_unit=excluded.preco_unit, tarifa_unit=excluded.tarifa_unit,
                           envio_id=excluded.envio_id, sku=COALESCE(excluded.sku, vendas.sku),
                           origem=COALESCE(excluded.origem, vendas.origem)`);
  db.exec('BEGIN');
  try {
    for (const l of linhas) {
      st.run(l.order_id, l.item_id, l.variacao || 0, l.ml_user_id, l.data, l.status ?? null,
        l.quantidade, l.preco_unit, l.tarifa_unit ?? null, l.envio_id ?? null, l.sku ?? null, l.origem ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Um resumo por anúncio da conta na janela j = { de, meio, ate } (ISO, ate exclusivo).
// `meio` separa as duas metades para a tendência — a mesma conta que ordena "maiores
// quedas" e pinta o selo na listagem.
const vendasResumo = (mlUserId, j) =>
  db.prepare(`SELECT item_id,
                     SUM(quantidade) AS unidades,
                     COUNT(DISTINCT order_id) AS pedidos,
                     SUM(quantidade * preco_unit) AS faturamento,
                     SUM(quantidade * COALESCE(tarifa_unit, 0)) AS tarifas,
                     COUNT(DISTINCT envio_id) AS envios,
                     SUM(CASE WHEN data < ? THEN quantidade ELSE 0 END) AS antes,
                     SUM(CASE WHEN data >= ? THEN quantidade ELSE 0 END) AS depois
              FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND ${EM_VENDA}
              GROUP BY item_id`).all(j.meio, j.meio, mlUserId, j.de, j.ate);

// Vendas da conta somadas por DIA do vendedor (Brasília, UTC-3), para o painel de início.
// O recorte é por intervalo cru (`de`/`ate` ISO) e não pela janela de dias fechados: o
// dashboard mostra HOJE, que ainda está pela metade.
const vendasPorDia = (mlUserId, de, ate) =>
  db.prepare(`SELECT substr(datetime(data, '-3 hours'), 1, 10) AS dia,
                     SUM(quantidade) AS unidades,
                     COUNT(DISTINCT order_id) AS pedidos,
                     SUM(quantidade * preco_unit) AS faturamento,
                     SUM(quantidade * COALESCE(tarifa_unit, 0)) AS tarifas
              FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND ${EM_VENDA}
              GROUP BY dia ORDER BY dia`).all(mlUserId, de, ate);

// Os anúncios que mais faturaram no intervalo.
const vendasTopItens = (mlUserId, de, ate, limite = 5) =>
  db.prepare(`SELECT item_id,
                     SUM(quantidade) AS unidades,
                     COUNT(DISTINCT order_id) AS pedidos,
                     SUM(quantidade * preco_unit) AS faturamento
              FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND ${EM_VENDA}
              GROUP BY item_id ORDER BY faturamento DESC LIMIT ?`).all(mlUserId, de, ate, limite);

// Os últimos pedidos do intervalo, um por linha (um pedido pode ter vários anúncios).
const vendasRecentes = (mlUserId, de, ate, limite = 8) =>
  db.prepare(`SELECT order_id, MAX(data) AS data, SUM(quantidade) AS quantidade,
                     SUM(quantidade * preco_unit) AS total,
                     COUNT(DISTINCT item_id) AS anuncios, MIN(item_id) AS item_id
              FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND ${EM_VENDA}
              GROUP BY order_id ORDER BY data DESC LIMIT ?`).all(mlUserId, de, ate, limite);

// Unidades por linha de pedido, para montar a série diária de alguns anúncios.
function vendasDiarias(ids, j) {
  if (!ids.length) return [];
  return db.prepare(`SELECT item_id, data, quantidade FROM vendas
                     WHERE item_id IN (${ids.map(() => '?').join(',')}) AND data >= ? AND data < ?
                       AND ${EM_VENDA}`)
    .all(...ids, j.de, j.ate);
}

const vendasUltimas = (itemId, limite = 5) =>
  db.prepare(`SELECT order_id, data, status, SUM(quantidade) AS quantidade,
                     SUM(quantidade * preco_unit) AS total
              FROM vendas WHERE item_id=? GROUP BY order_id ORDER BY data DESC LIMIT ?`).all(itemId, limite);

// Envios recentes do anúncio cujo frete ainda não foi consultado.
const enviosSemFrete = (itemId, j, limite) =>
  db.prepare(`SELECT v.envio_id, MAX(v.data) AS data FROM vendas v
              LEFT JOIN fretes f ON f.envio_id = v.envio_id
              WHERE v.item_id=? AND v.data >= ? AND v.data < ? AND v.envio_id IS NOT NULL
                AND f.envio_id IS NULL AND v.${EM_VENDA}
              GROUP BY v.envio_id ORDER BY data DESC LIMIT ?`).all(itemId, j.de, j.ate, limite).map((r) => r.envio_id);

// Frete por UNIDADE nos envios do anúncio já consultados na janela: soma do frete ÷ soma
// das unidades. Medido numa conta real: o frete por envio ia de R$ 0 a R$ 253 conforme a
// quantidade no pedido (média de 7 un.) — a média por envio errava; por unidade, não.
const fretePorUnidade = (itemId, j) =>
  db.prepare(`SELECT SUM(f.custo) AS custo, SUM(u.qtd) AS unidades, COUNT(*) AS amostra
              FROM fretes f
              JOIN (SELECT envio_id, SUM(quantidade) AS qtd FROM vendas
                    WHERE item_id=? AND data >= ? AND data < ? AND envio_id IS NOT NULL AND ${EM_VENDA}
                    GROUP BY envio_id) u ON u.envio_id = f.envio_id`)
    .get(itemId, j.de, j.ate);

const freteGravar = (mlUserId, envioId, custo) =>
  db.prepare(`INSERT INTO fretes (envio_id, ml_user_id, custo, medido_em) VALUES (?,?,?,?)
              ON CONFLICT(envio_id) DO UPDATE SET custo=excluded.custo, medido_em=excluded.medido_em`)
    .run(envioId, mlUserId, custo, agora());

// ---------- promoções: de qual promoção veio cada venda ----------
// O pedido não diz o nome da promoção: /orders/{id}/discounts dá a oferta (OFFER-MLB…),
// /seller-promotions/offers/{oferta} dá a promoção e /seller-promotions/promotions/{id}
// o nome. Medido em 28/09/2026: funciona até com promoção já encerrada. Nada disso muda
// depois da venda, então cada pedido, oferta e promoção é consultado uma vez só.
// promo_lidos marca o pedido já consultado (inclusive os sem desconto, que não viram linha
// em promo_pedidos). Uma linha por (pedido, anúncio): com dois descontos na mesma linha
// fica o maior, e os valores somam os dois.
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_lidos (
    order_id   INTEGER PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    lido_em    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS promo_pedidos (
    order_id          INTEGER NOT NULL,
    item_id           TEXT NOT NULL,
    ml_user_id        INTEGER NOT NULL,
    oferta_id         TEXT,
    financiamento     TEXT,
    desconto_total    REAL NOT NULL DEFAULT 0,
    desconto_vendedor REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS promo_ofertas (
    oferta_id   TEXT PRIMARY KEY,
    promocao_id TEXT,
    tipo        TEXT
  );
  CREATE TABLE IF NOT EXISTS promo_nomes (
    promocao_id TEXT PRIMARY KEY,
    tipo        TEXT,
    nome        TEXT,
    inicio      TEXT,
    fim         TEXT,
    status      TEXT
  );
`);

const promoPedidosSemLeitura = (mlUserId, de, ate) =>
  db.prepare(`SELECT DISTINCT v.order_id FROM vendas v
              LEFT JOIN promo_lidos l ON l.order_id = v.order_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.${EM_VENDA} AND l.order_id IS NULL`)
    .all(mlUserId, de, ate).map((r) => r.order_id);

function promoPedidoGravar(mlUserId, orderId, linhas) {
  const st = db.prepare(`INSERT INTO promo_pedidos (order_id, item_id, ml_user_id, oferta_id, financiamento,
                                                    desconto_total, desconto_vendedor)
                         VALUES (?,?,?,?,?,?,?)
                         ON CONFLICT(order_id, item_id) DO UPDATE SET oferta_id=excluded.oferta_id,
                           financiamento=excluded.financiamento, desconto_total=excluded.desconto_total,
                           desconto_vendedor=excluded.desconto_vendedor`);
  db.exec('BEGIN');
  try {
    for (const l of linhas) {
      st.run(orderId, l.item_id, mlUserId, l.oferta_id ?? null, l.financiamento ?? null,
        l.desconto_total || 0, l.desconto_vendedor || 0);
    }
    db.prepare('INSERT OR REPLACE INTO promo_lidos (order_id, ml_user_id, lido_em) VALUES (?,?,?)')
      .run(orderId, mlUserId, agora());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const promoOfertasSemPromocao = (mlUserId) =>
  db.prepare(`SELECT DISTINCT p.oferta_id FROM promo_pedidos p
              LEFT JOIN promo_ofertas o ON o.oferta_id = p.oferta_id
              WHERE p.ml_user_id=? AND p.oferta_id IS NOT NULL AND o.oferta_id IS NULL`)
    .all(mlUserId).map((r) => r.oferta_id);
const promoOfertaGravar = (ofertaId, promocaoId, tipo) =>
  db.prepare('INSERT OR REPLACE INTO promo_ofertas (oferta_id, promocao_id, tipo) VALUES (?,?,?)')
    .run(ofertaId, promocaoId ?? null, tipo ?? null);

const promoNomesFaltando = () =>
  db.prepare(`SELECT DISTINCT o.promocao_id, o.tipo FROM promo_ofertas o
              LEFT JOIN promo_nomes n ON n.promocao_id = o.promocao_id
              WHERE o.promocao_id IS NOT NULL AND n.promocao_id IS NULL`).all();
const promoNomeGravar = (p) =>
  db.prepare(`INSERT OR REPLACE INTO promo_nomes (promocao_id, tipo, nome, inicio, fim, status)
              VALUES (?,?,?,?,?,?)`)
    .run(p.id, p.type ?? null, p.name ?? null, p.start_date ?? null, p.finish_date ?? null, p.status ?? null);

// Vendas da janela agrupadas pela promoção que deu o desconto. Linha sem desconto cai em
// promocao_id NULL e tipo NULL ("sem promoção"); desconto sem oferta é cupom (type "coupon"
// em /orders/{id}/discounts, medido em 28/09/2026); pedido ainda não consultado fica de fora.
const promoResultado = (mlUserId, de, ate) =>
  db.prepare(`SELECT o.promocao_id,
                     COALESCE(o.tipo, CASE WHEN p.order_id IS NULL THEN NULL
                                           WHEN p.oferta_id IS NULL THEN 'CUPOM' ELSE 'DESCONHECIDA' END) AS tipo,
                     n.nome, n.inicio, n.fim, n.status,
                     COUNT(DISTINCT v.order_id) AS pedidos,
                     COUNT(DISTINCT v.item_id) AS anuncios,
                     SUM(v.quantidade) AS unidades,
                     SUM(v.quantidade * v.preco_unit) AS faturamento,
                     SUM(v.quantidade * COALESCE(v.tarifa_unit, 0)) AS tarifas,
                     SUM(COALESCE(p.desconto_total, 0)) AS desconto_total,
                     SUM(COALESCE(p.desconto_vendedor, 0)) AS desconto_vendedor
              FROM vendas v
              JOIN promo_lidos l ON l.order_id = v.order_id
              LEFT JOIN promo_pedidos p ON p.order_id = v.order_id AND p.item_id = v.item_id
              LEFT JOIN promo_ofertas o ON o.oferta_id = p.oferta_id
              LEFT JOIN promo_nomes n ON n.promocao_id = o.promocao_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.${EM_VENDA}
              GROUP BY o.promocao_id, 2
              ORDER BY faturamento DESC`).all(mlUserId, de, ate);

// Os anúncios que mais venderam dentro de uma promoção (ou sem promoção, com id null).
const promoTopItens = (mlUserId, promocaoId, de, ate, limite = 10) =>
  db.prepare(`SELECT v.item_id, SUM(v.quantidade) AS unidades, COUNT(DISTINCT v.order_id) AS pedidos,
                     SUM(v.quantidade * v.preco_unit) AS faturamento,
                     SUM(COALESCE(p.desconto_vendedor, 0)) AS desconto_vendedor
              FROM vendas v
              JOIN promo_lidos l ON l.order_id = v.order_id
              LEFT JOIN promo_pedidos p ON p.order_id = v.order_id AND p.item_id = v.item_id
              LEFT JOIN promo_ofertas o ON o.oferta_id = p.oferta_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.${EM_VENDA}
                AND (o.promocao_id = ? OR (? IS NULL AND p.oferta_id IS NULL))
              GROUP BY v.item_id ORDER BY faturamento DESC LIMIT ?`)
    .all(mlUserId, de, ate, promocaoId, promocaoId, limite);

// ---------- devoluções e reclamações ----------
// Uma linha por reclamação (claim) do ML, com os custos já somados. Os detalhes (pedido,
// frete de ida, envio de volta) custam ~5 chamadas por reclamação: só se refaz a conta
// quando o last_updated da reclamação muda.
db.exec(`
  CREATE TABLE IF NOT EXISTS devolucoes (
    claim_id       INTEGER PRIMARY KEY,
    ml_user_id     INTEGER NOT NULL,
    tipo           TEXT,
    status         TEXT,
    etapa          TEXT,
    motivo_id      TEXT,
    order_id       INTEGER,
    item_id        TEXT,
    quantidade     REAL,
    criada_em      TEXT NOT NULL,
    atualizada_em  TEXT,
    resolucao      TEXT,
    beneficiado    TEXT,
    cobertura_ml   INTEGER,
    valor_pedido   REAL,
    reembolsado    REAL,
    frete_ida      REAL,
    frete_volta    REAL,
    tarifa_devolucao REAL,
    status_devolucao TEXT,
    status_dinheiro  TEXT,
    acoes          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_devol_conta_data ON devolucoes(ml_user_id, criada_em);
`);
// Notas fiscais (JSON) da venda e da devolução; NULL = ainda não consultado.
colunaNova('devolucoes', 'nf_venda TEXT');
colunaNova('devolucoes', 'nf_devolucao TEXT');
// Quem pagou o reembolso (Mercado Pago: refunds[].source), o que foi estornado ao vendedor,
// a revisão do produto devolvido e a mensagem do ML. reembolso_ml NULL = linha antiga.
for (const c of ['reembolso_ml REAL', 'reembolso_vendedor REAL', 'frete_ida_estornado REAL', 'tarifas REAL',
  'tarifas_estornadas REAL', 'custo_produto REAL', 'revisao TEXT', 'detalhe_ml TEXT', 'fonte_dinheiro TEXT']) {
  colunaNova('devolucoes', c);
}

const DEVOL_CAMPOS = ['claim_id', 'ml_user_id', 'tipo', 'status', 'etapa', 'motivo_id', 'order_id', 'item_id',
  'quantidade', 'criada_em', 'atualizada_em', 'resolucao', 'beneficiado', 'cobertura_ml', 'valor_pedido',
  'reembolsado', 'frete_ida', 'frete_volta', 'tarifa_devolucao', 'status_devolucao', 'status_dinheiro', 'acoes',
  'nf_venda', 'nf_devolucao', 'reembolso_ml', 'reembolso_vendedor', 'frete_ida_estornado', 'tarifas',
  'tarifas_estornadas', 'custo_produto', 'revisao', 'detalhe_ml', 'fonte_dinheiro'];
function devolucaoGravar(d) {
  db.prepare(`INSERT OR REPLACE INTO devolucoes (${DEVOL_CAMPOS.join(',')})
              VALUES (${DEVOL_CAMPOS.map(() => '?').join(',')})`)
    .run(...DEVOL_CAMPOS.map((c) => d[c] ?? null));
}
// Linha gravada antes das colunas de nota fiscal existirem conta como desatualizada.
const devolucaoAtualizadaEm = (claimId) => {
  const r = db.prepare('SELECT atualizada_em, nf_venda, reembolso_ml FROM devolucoes WHERE claim_id=?').get(claimId);
  // reembolso_ml > 0 = gravada quando "bpp" era lido como "o ML pagou" (errado): refaz
  return r && r.nf_venda != null && r.reembolso_ml === 0 ? r.atualizada_em : null;
};
const devolucoesListar = (mlUserId, de, ate) =>
  db.prepare(`SELECT * FROM devolucoes WHERE ml_user_id=? AND criada_em >= ? AND criada_em < ?
              ORDER BY criada_em DESC`).all(mlUserId, de, ate);

// Últimos preços pelos quais cada anúncio vendeu (da cópia local dos pedidos) e a data
// da última venda — para a tela de promoções mostrar o histórico e filtrar parados.
function ultimasVendas(ids, n = 3) {
  if (!ids.length) return {};
  const linhas = db.prepare(`SELECT item_id, data, preco_unit, quantidade FROM (
                               SELECT item_id, data, preco_unit, quantidade,
                                      ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY data DESC) AS k
                               FROM vendas WHERE item_id IN (${ids.map(() => '?').join(',')}) AND ${EM_VENDA})
                             WHERE k <= ?`).all(...ids, n);
  const out = {};
  for (const l of linhas) (out[l.item_id] ||= []).push({ data: l.data, preco: l.preco_unit, quantidade: l.quantidade });
  return out;
}
// Data da venda mais antiga guardada: até onde o "não vendeu há X dias" é confiável.
const vendasDesde = (mlUserId) => db.prepare('SELECT MIN(data) AS d FROM vendas WHERE ml_user_id=?').get(mlUserId)?.d ?? null;

// ---------- vendas linha a linha (tela Vendas) ----------
// Todas as linhas de pedido do intervalo com o frete do envio (quando já medido) e quantas
// linhas dividem o mesmo envio, para ratear o frete de um pacote entre os anúncios dele.
const vendasLinhas = (mlUserId, de, ate) =>
  db.prepare(`SELECT v.order_id, v.item_id, v.variacao, v.data, v.status, v.quantidade, v.preco_unit,
                     v.tarifa_unit, v.envio_id, v.sku, v.origem, f.custo AS frete_envio,
                     (SELECT SUM(x.quantidade * x.preco_unit) FROM vendas x
                       WHERE x.envio_id = v.envio_id AND x.ml_user_id = v.ml_user_id) AS total_envio
              FROM vendas v LEFT JOIN fretes f ON f.envio_id = v.envio_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ?
              ORDER BY v.data DESC`).all(mlUserId, de, ate);
// Linhas baixadas antes de o painel guardar SKU ou origem do estoque: a janela é baixada de novo.
const vendasSemSku = (mlUserId, de, ate) =>
  db.prepare('SELECT COUNT(*) AS n FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND (sku IS NULL OR origem IS NULL)')
    .get(mlUserId, de, ate).n;

// ---------- avisos (vendas novas, mensagens, anúncio pausado) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS avisos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    tipo       TEXT NOT NULL,
    chave      TEXT NOT NULL,
    titulo     TEXT NOT NULL,
    texto      TEXT,
    link       TEXT,
    criado_em  TEXT NOT NULL,
    lido       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (ml_user_id, chave)
  );
  CREATE INDEX IF NOT EXISTS idx_avisos_conta ON avisos(ml_user_id, id DESC);
`);
// Grava o aviso só se a chave for nova (a mesma venda ou pausa não avisa duas vezes).
const avisoCriar = (mlUserId, a) => db.prepare(`INSERT OR IGNORE INTO avisos (ml_user_id, tipo, chave, titulo, texto, link, criado_em)
                                                VALUES (?,?,?,?,?,?,?)`)
  .run(mlUserId, a.tipo, a.chave, a.titulo, a.texto ?? null, a.link ?? null, a.criado_em || agora()).changes > 0;
const avisosListar = (mlUserId, limite = 50) =>
  db.prepare('SELECT * FROM avisos WHERE ml_user_id=? ORDER BY id DESC LIMIT ?').all(mlUserId, limite);
const avisosNaoLidos = (mlUserId) =>
  db.prepare('SELECT COUNT(*) AS n FROM avisos WHERE ml_user_id=? AND lido=0').get(mlUserId).n;
const avisosMarcarLidos = (mlUserId, ids) => (ids && ids.length
  ? db.prepare(`UPDATE avisos SET lido=1 WHERE ml_user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(mlUserId, ...ids)
  : db.prepare('UPDATE avisos SET lido=1 WHERE ml_user_id=?').run(mlUserId));

// ---------- devolução: produto com defeito (marcado pelo vendedor) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS devolucao_defeito (
    claim_id      INTEGER PRIMARY KEY,
    defeito       INTEGER NOT NULL,
    atualizado_em TEXT NOT NULL
  );
`);
// produtos: quais peças do kit estão com defeito — posições na lista de componentes do SKU
// vendido ("[0,2]"). NULL = marcação antiga ou anúncio de um produto só (vale o kit inteiro).
colunaNova('devolucao_defeito', 'produtos TEXT');
const defeitoGravar = (claimId, defeito, produtos = null) =>
  db.prepare('INSERT OR REPLACE INTO devolucao_defeito (claim_id, defeito, produtos, atualizado_em) VALUES (?,?,?,?)')
    .run(claimId, defeito ? 1 : 0, Array.isArray(produtos) ? JSON.stringify(produtos) : null, agora());
const defeitosDe = () => Object.fromEntries(db.prepare('SELECT claim_id, defeito FROM devolucao_defeito').all()
  .map((r) => [r.claim_id, r.defeito === 1]));
const defeitoProdutosDe = () => Object.fromEntries(db.prepare('SELECT claim_id, produtos FROM devolucao_defeito WHERE produtos IS NOT NULL').all()
  .map((r) => { try { return [r.claim_id, JSON.parse(r.produtos)]; } catch { return [r.claim_id, null]; } }));
// SKU da unidade vendida em cada pedido (para abrir o kit da devolução nos produtos dele).
const skusDosPedidos = (orderIds) => {
  const out = {};
  for (let i = 0; i < orderIds.length; i += 400) {
    const lote = orderIds.slice(i, i + 400);
    for (const r of db.prepare(`SELECT order_id, item_id, sku FROM vendas WHERE order_id IN (${lote.map(() => '?').join(',')})`).all(...lote)) {
      if (r.sku) out[`${r.order_id}|${r.item_id}`] = r.sku;
    }
  }
  return out;
};

// ---------- Mercado Ads: mudanças nas campanhas ----------
// O ML não tem histórico de alterações da campanha (só o last_updated). O painel guarda a
// última configuração vista de cada campanha e, quando ela muda, grava o que mudou — o
// histórico começa no dia em que o painel viu a campanha pela primeira vez.
db.exec(`
  CREATE TABLE IF NOT EXISTS ads_campanhas (
    campanha_id INTEGER PRIMARY KEY,
    ml_user_id  INTEGER NOT NULL,
    dados       TEXT NOT NULL,
    visto_em    TEXT NOT NULL,
    desde       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ads_mudancas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id  INTEGER NOT NULL,
    campanha_id INTEGER NOT NULL,
    campanha    TEXT,
    campo       TEXT NOT NULL,
    de          TEXT,
    para        TEXT,
    em          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ads_mudancas ON ads_mudancas(ml_user_id, em);
`);
const adsCampanhasVistas = (mlUserId) => Object.fromEntries(
  db.prepare('SELECT campanha_id, dados, desde FROM ads_campanhas WHERE ml_user_id=?').all(mlUserId)
    .map((r) => [r.campanha_id, { ...JSON.parse(r.dados), desde: r.desde }]));
const adsCampanhaGravar = (mlUserId, id, dados) =>
  db.prepare(`INSERT INTO ads_campanhas (campanha_id, ml_user_id, dados, visto_em, desde) VALUES (?,?,?,?,?)
              ON CONFLICT(campanha_id) DO UPDATE SET dados=excluded.dados, visto_em=excluded.visto_em`)
    .run(id, mlUserId, JSON.stringify(dados), agora(), agora());
const adsMudancaGravar = (mlUserId, m) =>
  db.prepare('INSERT INTO ads_mudancas (ml_user_id, campanha_id, campanha, campo, de, para, em) VALUES (?,?,?,?,?,?,?)')
    .run(mlUserId, m.campanha_id, m.campanha ?? null, m.campo, m.de == null ? null : String(m.de), m.para == null ? null : String(m.para), m.em || agora());
const adsMudancas = (mlUserId, de, campanhaId = null) =>
  db.prepare(`SELECT id, campanha_id, campanha, campo, de, para, em FROM ads_mudancas
              WHERE ml_user_id=? AND em >= ? ${campanhaId ? 'AND campanha_id=?' : ''} ORDER BY em DESC, id DESC`)
    .all(...(campanhaId ? [mlUserId, de, campanhaId] : [mlUserId, de]));
// Desde quando o painel acompanha as campanhas da conta (a primeira vez que viu alguma).
const adsHistoricoDesde = (mlUserId) =>
  db.prepare('SELECT MIN(desde) AS d FROM ads_campanhas WHERE ml_user_id=?').get(mlUserId)?.d ?? null;

// ---------- tipo de logística de cada envio (Full, Flex, Mercado Envios) ----------
// /shipments/{id} -> logistic_type. Medido em 30/09/2026 numa conta real: "self_service" = Flex
// (entrega no mesmo dia pelo vendedor), "fulfillment" = Full, "cross_docking"/"xd_drop_off"/
// "drop_off" = Mercado Envios (coleta ou agência). Não muda depois: uma consulta por envio.
db.exec(`
  CREATE TABLE IF NOT EXISTS envio_logistica (
    envio_id   INTEGER PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    tipo       TEXT NOT NULL
  );
`);
const logisticaGravar = (mlUserId, envioId, tipo) =>
  db.prepare('INSERT OR REPLACE INTO envio_logistica (envio_id, ml_user_id, tipo) VALUES (?,?,?)').run(envioId, mlUserId, tipo);
// Envios do intervalo que ainda não têm o tipo (os do Full saem da origem do estoque, sem consulta).
const enviosSemLogistica = (mlUserId, de, ate, limite) =>
  db.prepare(`SELECT DISTINCT v.envio_id FROM vendas v LEFT JOIN envio_logistica g ON g.envio_id = v.envio_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.envio_id IS NOT NULL AND g.envio_id IS NULL
                AND v.${EM_VENDA} AND (v.origem IS NULL OR v.origem = '' OR v.origem GLOB 'BRP[0-9]*')
              ORDER BY v.data DESC LIMIT ?`).all(mlUserId, de, ate, limite).map((r) => r.envio_id);
// Linhas de venda do intervalo com a origem do estoque e o tipo de logística do envio.
const vendasComLogistica = (mlUserId, de, ate) =>
  db.prepare(`SELECT v.order_id, v.envio_id, v.origem, g.tipo, v.quantidade, v.quantidade * v.preco_unit AS faturamento
              FROM vendas v LEFT JOIN envio_logistica g ON g.envio_id = v.envio_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.${EM_VENDA}`).all(mlUserId, de, ate);

// ---------- qualidade dos anúncios (/item/{id}/performance), guardada por 3 dias ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS anuncio_qualidade (
    item_id     TEXT PRIMARY KEY,
    ml_user_id  INTEGER NOT NULL,
    score       REAL,
    nivel       TEXT,
    pendentes   TEXT,
    calculado_em TEXT NOT NULL
  );
`);
const qualidadeGravar = (mlUserId, itemId, q) =>
  db.prepare(`INSERT OR REPLACE INTO anuncio_qualidade (item_id, ml_user_id, score, nivel, pendentes, calculado_em)
              VALUES (?,?,?,?,?,?)`).run(itemId, mlUserId, q.score ?? null, q.nivel ?? null, JSON.stringify(q.pendentes || []), agora());
const qualidadeDe = (ids) => {
  if (!ids.length) return {};
  return Object.fromEntries(db.prepare(`SELECT * FROM anuncio_qualidade WHERE item_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map((r) => [r.item_id, { ...r, pendentes: JSON.parse(r.pendentes || '[]') }]));
};
const enviosSemFreteConta = (mlUserId, de, ate, limite) =>
  db.prepare(`SELECT DISTINCT v.envio_id FROM vendas v LEFT JOIN fretes f ON f.envio_id = v.envio_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ? AND v.envio_id IS NOT NULL
                AND f.envio_id IS NULL AND v.${EM_VENDA}
              ORDER BY v.data DESC LIMIT ?`).all(mlUserId, de, ate, limite).map((r) => r.envio_id);

// Unidades vendidas por anúncio na janela, para a taxa de devolução. Sem filtro de status
// de propósito: pedido devolvido vira "cancelled" e sumiria da base da própria taxa.
function vendasUnidadesPorItem(mlUserId, ids, de, ate) {
  if (!ids.length) return {};
  return Object.fromEntries(db.prepare(`SELECT item_id, SUM(quantidade) AS unidades, COUNT(DISTINCT order_id) AS pedidos
                     FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ?
                       AND item_id IN (${ids.map(() => '?').join(',')})
                     GROUP BY item_id`).all(mlUserId, de, ate, ...ids)
    .map((r) => [r.item_id, { unidades: r.unidades, pedidos: r.pedidos }]));
}

// ---------- configuração do painel (primeiro acesso) ----------
// O que antes vivia no .env e o aluno teria de editar à mão: senha do painel, App ID e
// chave secreta do DevCenter. Mora na tabela estado; o que é segredo vai cifrado.
const CONFIG_SECRETA = new Set(['ml_client_secret']);

function configLer(chave) {
  const v = db.prepare('SELECT valor FROM estado WHERE chave=?').get(chave)?.valor ?? null;
  return CONFIG_SECRETA.has(chave) ? decifrar(v) : v;
}

function configGravar(chave, valor) {
  const v = valor == null ? null : (CONFIG_SECRETA.has(chave) ? cifrar(String(valor)) : String(valor));
  db.prepare(`INSERT INTO estado (chave, valor) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor`).run(chave, v);
}

// ---------- senha e sessões do painel ----------
// scrypt com sal: o banco vazado não entrega a senha. A sessão é um token aleatório
// guardado só como hash — dá para revogar (sair, trocar senha), o que um cookie
// derivado da senha não permitia.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    criada_em  TEXT NOT NULL,
    expira_em  INTEGER NOT NULL
  );
`);

function senhaDefinir(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), sal, 64);
  configGravar('painel_senha', `scrypt:${sal.toString('base64')}:${hash.toString('base64')}`);
  db.prepare('DELETE FROM sessoes').run(); // senha nova derruba quem estava logado
}

const senhaDefinida = () => !!configLer('painel_senha');

function senhaConfere(senha) {
  const [tipo, sal, hash] = String(configLer('painel_senha') || '').split(':');
  if (tipo !== 'scrypt' || !sal || !hash) return false;
  const esperado = Buffer.from(hash, 'base64');
  const obtido = crypto.scryptSync(String(senha), Buffer.from(sal, 'base64'), esperado.length);
  return crypto.timingSafeEqual(obtido, esperado);
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOKEN = /^[a-f0-9]{64}$/;

function sessaoCriar(dias = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes (token_hash, criada_em, expira_em) VALUES (?,?,?)')
    .run(hashToken(token), agora(), Date.now() + dias * 864e5);
  return token;
}

function sessaoValida(token) {
  if (!TOKEN.test(token || '')) return false;
  const s = db.prepare('SELECT expira_em FROM sessoes WHERE token_hash=?').get(hashToken(token));
  return !!s && s.expira_em > Date.now();
}

const sessaoEncerrar = (token) => {
  if (TOKEN.test(token || '')) db.prepare('DELETE FROM sessoes WHERE token_hash=?').run(hashToken(token));
};

// ---------- URL pública (túnel) ----------
// O túnel gratuito troca de endereço a cada reinício. Cada endereço fica registrado para
// o painel dizer "mudou de X para Y" — e para o aluno saber o que atualizar no DevCenter.
db.exec(`
  CREATE TABLE IF NOT EXISTS urls_publicas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL,
    provedor    TEXT,
    iniciada_em TEXT NOT NULL
  );
`);

const urlPublicaUltima = () =>
  db.prepare('SELECT url, provedor, iniciada_em FROM urls_publicas ORDER BY id DESC LIMIT 1').get() ?? null;

// Devolve a anterior para quem chama avisar da troca. Repetir a mesma URL não gera linha.
function urlPublicaRegistrar(url, provedor) {
  const ultima = urlPublicaUltima();
  if (ultima?.url === url) return { anterior: ultima.url, mudou: false };
  db.prepare('INSERT INTO urls_publicas (url, provedor, iniciada_em) VALUES (?,?,?)').run(url, provedor, agora());
  return { anterior: ultima?.url ?? null, mudou: !!ultima };
}

const urlsPublicasHistorico = (limite = 10) =>
  db.prepare('SELECT url, provedor, iniciada_em FROM urls_publicas ORDER BY id DESC LIMIT ?').all(limite);

module.exports = {
  db, DB_FILE, cifrar, decifrar,
  configLer, configGravar,
  senhaDefinir, senhaDefinida, senhaConfere, sessaoCriar, sessaoValida, sessaoEncerrar,
  urlPublicaRegistrar, urlPublicaUltima, urlsPublicasHistorico,
  contaSalvar, contaTokensAtualizar, contaObter, contasListar,
  contaAtiva, contaAtivaId, contaAtivaDefinir, contaRemover,
  produtoSalvar, produtoSincronizar, produtosListar,
  palavraAdicionar, palavraRemover, palavrasListar, posicaoSalvar, posicoesHistorico, notificacaoSalvar, notificacoesListar,
  custoGravar, custoObter, custosDe, impostoLer, impostoGravar, STATUS_VENDA,
  vendasGravar, vendasResumo, vendasDiarias, vendasUltimas, enviosSemFrete, fretePorUnidade, freteGravar,
  vendasPorDia, vendasTopItens, vendasRecentes,
  promoPedidosSemLeitura, promoPedidoGravar, promoOfertasSemPromocao, promoOfertaGravar,
  promoNomesFaltando, promoNomeGravar, promoResultado, promoTopItens,
  devolucaoGravar, devolucaoAtualizadaEm, devolucoesListar, vendasUnidadesPorItem,
  custoAutoGravar, embalagemGravar, catalogoGravar, catalogoListar, catalogoResumo,
  vendasLinhas, vendasSemSku, enviosSemFreteConta, ultimasVendas, vendasDesde,
  avisoCriar, avisosListar, avisosNaoLidos, avisosMarcarLidos, defeitoGravar, defeitosDe, defeitoProdutosDe,
  skusDosPedidos, extraGravar, logisticaGravar, enviosSemLogistica, vendasComLogistica,
  adsCampanhasVistas, adsCampanhaGravar, adsMudancaGravar, adsMudancas, adsHistoricoDesde,
  qualidadeGravar, qualidadeDe,
};
