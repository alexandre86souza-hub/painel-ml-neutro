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

// Conta ativa: a da SESSÃO de quem pediu (contexto.js), para cada pessoa do escritório olhar a sua
// sem trocar a dos outros; sem escolha na sessão (ou fora de pedido: MCP, segundo plano), a geral.
const CTX = require('./contexto.js');
const contaAtivaGeral = () => db.prepare("SELECT valor FROM estado WHERE chave='conta_ativa'").get()?.valor ?? null;
function contaAtivaId() {
  const c = CTX.atual();
  if (c?.conta && db.prepare('SELECT 1 FROM contas WHERE ml_user_id=?').get(Number(c.conta))) return c.conta;
  return contaAtivaGeral();
}

function contaAtivaDefinir(id) {
  if (id !== null && !db.prepare('SELECT 1 FROM contas WHERE ml_user_id=?').get(id)) {
    throw Object.assign(new Error('conta não conectada'), { status: 404 });
  }
  const c = CTX.atual();
  if (c?.sessao) {
    c.conta = id === null ? null : String(id);
    db.prepare('UPDATE sessoes SET conta_ativa=? WHERE token_hash=?').run(c.conta, c.sessao);
    if (contaAtivaGeral()) return;   // a geral só é escrita quando ainda não existe
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
// Cliente da venda (busca nas telas Pedidos e Devoluções): apelido vem na lista de pedidos;
// o nome só no pedido aberto (/orders/{id}), lido aos poucos. '' = o ML não mandou.
colunaNova('vendas', 'comprador_id INTEGER');
colunaNova('vendas', 'comprador TEXT');
colunaNova('vendas', 'comprador_nome TEXT');

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
                                             quantidade, preco_unit, tarifa_unit, envio_id, sku, origem, comprador_id, comprador)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(order_id, item_id, variacao) DO UPDATE SET
                           status=excluded.status, quantidade=excluded.quantidade,
                           preco_unit=excluded.preco_unit, tarifa_unit=excluded.tarifa_unit,
                           envio_id=excluded.envio_id, sku=COALESCE(excluded.sku, vendas.sku),
                           origem=COALESCE(excluded.origem, vendas.origem),
                           comprador_id=COALESCE(excluded.comprador_id, vendas.comprador_id),
                           comprador=COALESCE(excluded.comprador, vendas.comprador)`);
  db.exec('BEGIN');
  try {
    for (const l of linhas) {
      st.run(l.order_id, l.item_id, l.variacao || 0, l.ml_user_id, l.data, l.status ?? null,
        l.quantidade, l.preco_unit, l.tarifa_unit ?? null, l.envio_id ?? null, l.sku ?? null, l.origem ?? null,
        l.comprador_id ?? null, l.comprador ?? null);
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
  'tarifas_estornadas', 'custo_produto', 'revisao', 'detalhe_ml', 'fonte_dinheiro', 'pack_id'];
// pack_id: número do PACOTE que o ML mostra nas vendas (carrinho com vários pedidos); 0 = venda sem pacote.
colunaNova('devolucoes', 'pack_id INTEGER');
const devolucaoPackGravar = (orderId, pack) => db.prepare('UPDATE devolucoes SET pack_id=? WHERE order_id=?').run(pack, orderId);
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
                     v.tarifa_unit, v.envio_id, v.sku, v.origem, v.comprador, v.comprador_nome, f.custo AS frete_envio,
                     (SELECT SUM(x.quantidade * x.preco_unit) FROM vendas x
                       WHERE x.envio_id = v.envio_id AND x.ml_user_id = v.ml_user_id) AS total_envio
              FROM vendas v LEFT JOIN fretes f ON f.envio_id = v.envio_id
              WHERE v.ml_user_id=? AND v.data >= ? AND v.data < ?
              ORDER BY v.data DESC`).all(mlUserId, de, ate);
// Linhas baixadas antes de o painel guardar SKU ou origem do estoque: a janela é baixada de novo.
const vendasSemSku = (mlUserId, de, ate) =>
  db.prepare('SELECT COUNT(*) AS n FROM vendas WHERE ml_user_id=? AND data >= ? AND data < ? AND (sku IS NULL OR origem IS NULL OR comprador IS NULL)')
    .get(mlUserId, de, ate).n;
// Pedidos com cliente conhecido e sem o nome ainda (os mais novos primeiro).
const pedidosSemNome = (mlUserId, limite) => db.prepare(`SELECT DISTINCT order_id FROM vendas WHERE ml_user_id=?
  AND comprador_id IS NOT NULL AND comprador_nome IS NULL ORDER BY data DESC LIMIT ?`).all(mlUserId, limite).map((r) => r.order_id);
// Cliente de um pedido lido direto (/orders/{id}): grava nas linhas que existirem.
const compradorGravarPedido = (orderId, c) => db.prepare('UPDATE vendas SET comprador_id=?, comprador=?, comprador_nome=? WHERE order_id=?')
  .run(c.id ?? null, c.apelido ?? '', c.nome ?? '', orderId).changes;
const compradorNomeGravar = (orderId, nome) => db.prepare('UPDATE vendas SET comprador_nome=? WHERE order_id=?').run(nome ?? '', orderId);
// { order_id: { apelido, nome } } — para a tela Devoluções achar o cliente pelo pedido.
const compradoresDosPedidos = (orderIds) => {
  const out = {};
  for (let i = 0; i < orderIds.length; i += 400) {
    const lote = orderIds.slice(i, i + 400);
    for (const r of db.prepare(`SELECT order_id, MAX(comprador) AS apelido, MAX(comprador_nome) AS nome FROM vendas
      WHERE order_id IN (${lote.map(() => '?').join(',')}) GROUP BY order_id`).all(...lote)) out[r.order_id] = { apelido: r.apelido || null, nome: r.nome || null };
  }
  return out;
};

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
// Crédito do ML digitado pelo vendedor numa reclamação (quando o depósito não foi ligado sozinho,
// ou veio com valor diferente). Vale no lugar do crédito ligado automaticamente.
db.exec(`CREATE TABLE IF NOT EXISTS devolucao_credito (claim_id INTEGER PRIMARY KEY, valor REAL NOT NULL, gravado_em TEXT NOT NULL)`);
const creditoManualGravar = (claimId, valor) => (valor == null
  ? db.prepare('DELETE FROM devolucao_credito WHERE claim_id=?').run(claimId)
  : db.prepare('INSERT OR REPLACE INTO devolucao_credito (claim_id, valor, gravado_em) VALUES (?,?,?)').run(claimId, valor, agora()));
const creditosManuais = () => Object.fromEntries(db.prepare('SELECT claim_id, valor, gravado_em FROM devolucao_credito').all()
  .map((r) => [r.claim_id, { valor: r.valor, gravado_em: r.gravado_em }]));
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

// ---------- preço de atacado de cada anúncio (tela Produtos, atacado em massa) ----------
// Ler o atacado é uma chamada por anúncio (/items/{id}/prices): o que foi lido fica aqui e
// é refeito depois de cada gravação. faixas = [{quantidade, pct, preco}]; formato 'pct'
// (novo, em percentual), 'fixo' (antigo, em valor) ou NULL (sem atacado).
db.exec(`
  CREATE TABLE IF NOT EXISTS anuncio_atacado (
    item_id    TEXT PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    faixas     TEXT NOT NULL,
    formato    TEXT,
    lido_em    TEXT NOT NULL
  );
`);
const atacadoGravar = (mlUserId, itemId, faixas, formato) =>
  db.prepare('INSERT OR REPLACE INTO anuncio_atacado (item_id, ml_user_id, faixas, formato, lido_em) VALUES (?,?,?,?,?)')
    .run(itemId, mlUserId, JSON.stringify(faixas || []), formato || null, agora());
const atacadoDaConta = (mlUserId) => Object.fromEntries(
  db.prepare('SELECT item_id, faixas, formato, lido_em FROM anuncio_atacado WHERE ml_user_id=?').all(mlUserId)
    .map((r) => [r.item_id, { faixas: JSON.parse(r.faixas || '[]'), formato: r.formato, lido_em: r.lido_em }]));
const atacadoEsquecer = (mlUserId) => db.prepare('DELETE FROM anuncio_atacado WHERE ml_user_id=?').run(mlUserId);

// ---------- Shopee: lojas conectadas ----------
// Tokens cifrados como os do Mercado Livre. O refresh_token da Shopee é de uso único: cada
// renovação grava o par novo por cima (shopeeTokensGravar).
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_lojas (
    shop_id       INTEGER PRIMARY KEY,
    nome          TEXT,
    regiao        TEXT,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expira_em     INTEGER NOT NULL,
    conectada_em  TEXT NOT NULL,
    renovada_em   TEXT
  );
`);
const shopeeExpira = (t) => Date.now() + (Number(t.expire_in) || 4 * 3600) * 1000;
const shopeeLojaSalvar = (shopId, t) =>
  db.prepare(`INSERT INTO shopee_lojas (shop_id, access_token, refresh_token, expira_em, conectada_em) VALUES (?,?,?,?,?)
              ON CONFLICT(shop_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
                expira_em=excluded.expira_em, conectada_em=excluded.conectada_em`)
    .run(shopId, cifrar(t.access_token), cifrar(t.refresh_token), shopeeExpira(t), agora());
const shopeeTokensGravar = (shopId, t) =>
  db.prepare('UPDATE shopee_lojas SET access_token=?, refresh_token=?, expira_em=?, renovada_em=? WHERE shop_id=?')
    .run(cifrar(t.access_token), cifrar(t.refresh_token), shopeeExpira(t), agora(), shopId);
const shopeeLojaNomear = (shopId, nome, regiao) =>
  db.prepare('UPDATE shopee_lojas SET nome=?, regiao=? WHERE shop_id=?').run(nome, regiao, shopId);
function shopeeLojaObter(shopId) {
  const l = db.prepare('SELECT * FROM shopee_lojas WHERE shop_id=?').get(shopId);
  return l ? { ...l, access_token: decifrar(l.access_token), refresh_token: decifrar(l.refresh_token) } : null;
}
// Nunca devolve token — é o que vai para o navegador.
const shopeeLojasListar = () =>
  db.prepare('SELECT shop_id, nome, regiao, expira_em, conectada_em, renovada_em FROM shopee_lojas ORDER BY conectada_em').all();
const shopeeLojaRemover = (shopId) => db.prepare('DELETE FROM shopee_lojas WHERE shop_id=?').run(shopId);

// Pedidos da Shopee (cópia local, por loja): a lista dá o número e a situação; o detalhe dá a
// data, os itens (SKU, quantidade, preço) e a foto; o repasse (escrow) dá quanto o vendedor
// recebe e as taxas. Nada do comprador. Repasse final = pedido COMPLETED.
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_pedidos (
    order_sn      TEXT PRIMARY KEY,
    shop_id       INTEGER NOT NULL,
    data          TEXT,
    status        TEXT,
    atualizado    INTEGER,
    detalhe_lido  INTEGER NOT NULL DEFAULT 0,
    escrow_em     TEXT,
    escrow_final  INTEGER NOT NULL DEFAULT 0,
    recebido      REAL,
    comissao      REAL,
    servico       REAL,
    transacao     REAL,
    frete_vendedor REAL,
    cupom_vendedor REAL,
    devolucao     REAL
  );
  CREATE INDEX IF NOT EXISTS shopee_ped_loja_data ON shopee_pedidos(shop_id, data);
  CREATE TABLE IF NOT EXISTS shopee_itens (
    order_sn   TEXT NOT NULL,
    linha      INTEGER NOT NULL,
    sku        TEXT,
    item_id    INTEGER,
    model_id   INTEGER,
    nome       TEXT,
    quantidade INTEGER NOT NULL DEFAULT 0,
    preco_unit REAL,
    imagem     TEXT,
    PRIMARY KEY (order_sn, linha)
  );
`);
// Lista de pedidos: situação nova ou atualização nova = o detalhe e o repasse são lidos de novo.
function shopeePedidosGravar(shopId, lista) {
  const st = db.prepare(`INSERT INTO shopee_pedidos (order_sn, shop_id, status, atualizado) VALUES (?,?,?,?)
    ON CONFLICT(order_sn) DO UPDATE SET status=excluded.status,
      detalhe_lido=CASE WHEN shopee_pedidos.status IS NOT excluded.status THEN 0 ELSE shopee_pedidos.detalhe_lido END,
      escrow_final=CASE WHEN shopee_pedidos.status IS NOT excluded.status THEN 0 ELSE shopee_pedidos.escrow_final END,
      atualizado=COALESCE(excluded.atualizado, shopee_pedidos.atualizado)`);
  db.exec('BEGIN');
  try { for (const p of lista) st.run(p.order_sn, shopId, p.status ?? null, p.atualizado ?? null); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
// Transportadora do pedido (shipping_carrier: "Shopee Xpress", "Entrega Direta" = o vendedor
// entrega e paga a empresa de entrega) e o frete que a Shopee repassou ao vendedor
// (final_shipping_fee + buyer_paid_shipping_fee; medido: fecha o repasse em 94 de 100 pedidos).
// Colunas novas: relê o detalhe e o repasse dos pedidos que já estavam guardados.
const shopeeSemTransportadora = !db.prepare('PRAGMA table_info(shopee_pedidos)').all().some((c) => c.name === 'transportadora');
colunaNova('shopee_pedidos', 'transportadora TEXT');
colunaNova('shopee_pedidos', 'frete_shopee REAL');
colunaNova('shopee_pedidos', 'taxa_item REAL');   // sem uso: a taxa fixa sai da taxa de serviço (shopee-vendas.js#taxaFixaDe)
if (shopeeSemTransportadora) db.exec('UPDATE shopee_pedidos SET detalhe_lido=0');
const shopeeSemDetalhe = (shopId, limite) =>
  db.prepare('SELECT order_sn FROM shopee_pedidos WHERE shop_id=? AND detalhe_lido=0 LIMIT ?').all(shopId, limite).map((r) => r.order_sn);
function shopeeDetalheGravar(p, itens) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE shopee_pedidos SET data=?, status=?, atualizado=?, detalhe_lido=1, transportadora=? WHERE order_sn=?')
      .run(p.data, p.status, p.atualizado ?? null, p.transportadora ?? null, p.order_sn);
    db.prepare('DELETE FROM shopee_itens WHERE order_sn=?').run(p.order_sn);
    const st = db.prepare('INSERT INTO shopee_itens (order_sn, linha, sku, item_id, model_id, nome, quantidade, preco_unit, imagem) VALUES (?,?,?,?,?,?,?,?,?)');
    itens.forEach((i, k) => st.run(p.order_sn, k, i.sku, i.item_id ?? null, i.model_id ?? null, i.nome ?? null, i.quantidade, i.preco_unit ?? null, i.imagem ?? null));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Repasse a ler: pedido pago e não cancelado, sem repasse ou com repasse ainda provisório (12 h).
const shopeeSemEscrow = (shopId, limite) => db.prepare(`SELECT order_sn FROM shopee_pedidos WHERE shop_id=? AND detalhe_lido=1
  AND status NOT IN ('CANCELLED','IN_CANCEL','UNPAID')
  AND ((escrow_final=0 AND (escrow_em IS NULL OR escrow_em < ?)) OR (escrow_em IS NOT NULL AND frete_shopee IS NULL)) ORDER BY data DESC LIMIT ?`).all(shopId, new Date(Date.now() - 12 * 3600e3).toISOString(), limite).map((r) => r.order_sn);
const shopeeEscrowGravar = (orderSn, e) => db.prepare(`UPDATE shopee_pedidos SET escrow_em=?, escrow_final=?, recebido=?, comissao=?, servico=?,
  transacao=?, frete_vendedor=?, cupom_vendedor=?, devolucao=?, frete_shopee=? WHERE order_sn=?`)
  .run(agora(), e.final ? 1 : 0, e.recebido, e.comissao, e.servico, e.transacao, e.frete_vendedor, e.cupom_vendedor, e.devolucao, e.frete_shopee ?? 0, orderSn);
// Anúncios da Shopee (cópia local por loja, relida a cada 6 h): um registro por anúncio sem
// variação (model_id 0) ou por variação. Preço atual (com promoção) e original (o que o
// vendedor define), estoque, vendas do anúncio e visitas.
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_anuncios (
    shop_id        INTEGER NOT NULL,
    item_id        INTEGER NOT NULL,
    model_id       INTEGER NOT NULL DEFAULT 0,
    nome           TEXT,
    variacao       TEXT,
    sku            TEXT,
    preco          REAL,
    preco_original REAL,
    promocao       INTEGER NOT NULL DEFAULT 0,
    estoque        INTEGER,
    status         TEXT,
    imagem         TEXT,
    vendas_total   INTEGER,
    visitas        INTEGER,
    lido_em        TEXT NOT NULL,
    PRIMARY KEY (item_id, model_id)
  );
  CREATE INDEX IF NOT EXISTS shopee_anun_loja ON shopee_anuncios(shop_id);
`);
function shopeeAnunciosGravar(shopId, linhas) {
  const st = db.prepare(`INSERT OR REPLACE INTO shopee_anuncios (shop_id, item_id, model_id, nome, variacao, sku, preco, preco_original,
    promocao, estoque, status, imagem, vendas_total, visitas, lido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const quando = agora();
  db.exec('BEGIN');
  try {
    for (const a of linhas) st.run(shopId, a.item_id, a.model_id || 0, a.nome ?? null, a.variacao ?? null, a.sku ?? null, a.preco ?? null,
      a.preco_original ?? null, a.promocao ? 1 : 0, a.estoque ?? null, a.status ?? null, a.imagem ?? null, a.vendas_total ?? null, a.visitas ?? null, quando);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Leitura completa: o que não veio nela (anúncio apagado ou banido) sai.
const shopeeAnunciosLimparAntes = (shopId, quando) => db.prepare('DELETE FROM shopee_anuncios WHERE shop_id=? AND lido_em < ?').run(shopId, quando);
const shopeeAnuncios = (shopId) => db.prepare('SELECT * FROM shopee_anuncios WHERE shop_id=? ORDER BY item_id, model_id').all(shopId);
const shopeePrecoGravar = (itemId, modelId, preco, original) =>
  db.prepare('UPDATE shopee_anuncios SET preco=?, preco_original=? WHERE item_id=? AND model_id=?').run(preco, original, itemId, modelId || 0);

// Linhas de venda de uma loja na janela (pedido sem detalhe ainda não tem data: fica de fora).
const shopeeVendasPeriodo = (shopId, de, ate) => db.prepare(`
  SELECT p.order_sn, p.data, p.status, p.escrow_em, p.escrow_final, p.recebido, p.comissao, p.servico, p.transacao,
         p.frete_vendedor, p.cupom_vendedor, p.devolucao, p.transportadora, p.frete_shopee, p.taxa_item, i.linha, i.sku, i.item_id, i.nome, i.quantidade, i.preco_unit, i.imagem
  FROM shopee_pedidos p JOIN shopee_itens i ON i.order_sn = p.order_sn
  WHERE p.shop_id=? AND p.data >= ? AND p.data < ? ORDER BY p.data DESC, i.linha`).all(shopId, de, ate);
const shopeePendentes = (shopId) => db.prepare(`SELECT
  SUM(CASE WHEN detalhe_lido=0 THEN 1 ELSE 0 END) AS detalhe,
  SUM(CASE WHEN detalhe_lido=1 AND escrow_em IS NULL AND status NOT IN ('CANCELLED','IN_CANCEL','UNPAID') THEN 1 ELSE 0 END) AS repasse
  FROM shopee_pedidos WHERE shop_id=?`).get(shopId);

// ---------- Financeiro: pagamentos do Mercado Pago (o dinheiro das vendas) ----------
// Um registro por pagamento recebido pela conta (venda do ML ou outro crédito, como bônus do
// Flex e crédito de reclamação). Valores do próprio Mercado Pago: bruto, cada tarifa, líquido
// e a data em que o dinheiro é liberado. Nada do comprador.
db.exec(`
  CREATE TABLE IF NOT EXISTS mp_pagamentos (
    id            INTEGER PRIMARY KEY,
    ml_user_id    INTEGER NOT NULL,
    order_id      INTEGER,
    tipo          TEXT NOT NULL,          -- venda | outro
    descricao     TEXT,
    criado        TEXT,
    aprovado      TEXT,
    status        TEXT,
    status_detalhe TEXT,
    bruto         REAL,
    frete_cobrado REAL,
    reembolsado   REAL,
    liquido       REAL,
    tarifa_ml     REAL,
    tarifa_mp     REAL,
    frete         REAL,
    cupom         REAL,
    libera_em     TEXT,
    liberado      TEXT,                   -- released | pending
    atualizado    TEXT
  );
  CREATE INDEX IF NOT EXISTS mp_pag_conta_lib ON mp_pagamentos(ml_user_id, libera_em);
  CREATE INDEX IF NOT EXISTS mp_pag_order ON mp_pagamentos(order_id);
`);
function mpPagamentosGravar(linhas) {
  const st = db.prepare(`INSERT OR REPLACE INTO mp_pagamentos (id, ml_user_id, order_id, tipo, descricao, criado, aprovado, status, status_detalhe,
    bruto, frete_cobrado, reembolsado, liquido, tarifa_ml, tarifa_mp, frete, cupom, libera_em, liberado, atualizado, referencia, envio_id, ref_pagamento)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const p of linhas) st.run(p.id, p.ml_user_id, p.order_id, p.tipo, p.descricao, p.criado, p.aprovado, p.status, p.status_detalhe,
      p.bruto, p.frete_cobrado, p.reembolsado, p.liquido, p.tarifa_ml, p.tarifa_mp, p.frete, p.cupom, p.libera_em, p.liberado, p.atualizado,
      p.referencia ?? null, p.envio_id ?? null, p.ref_pagamento ?? null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return linhas.length;
}
// Pagamentos de uma conta (ou de todas) criados ou liberados na janela.
const mpPagamentos = (mlUserId, de, ate) => db.prepare(`SELECT * FROM mp_pagamentos WHERE (? IS NULL OR ml_user_id = ?)
  AND ((criado >= ? AND criado < ?) OR (libera_em >= ? AND libera_em < ?) OR (liberado = 'pending' AND status = 'approved'))
  ORDER BY COALESCE(libera_em, criado) DESC`).all(mlUserId, mlUserId, de, ate, de, ate);
// external_reference do pagamento: no frete pago à parte (description "marketplace_shipment") é
// o nº do ENVIO, e o order.id dele não é pedido (medido: /orders dá 404) -> envio_id. Coluna
// nova em banco que já tinha pagamentos: relê os 120 dias para preenchê-la.
// Bônus do Flex: envio_id vem de point_of_interaction.transaction_data (reference_type shipment);
// crédito de reclamação: ref_pagamento = o pagamento da venda (reference_type payment).
const mpSemReferencia = !db.prepare('PRAGMA table_info(mp_pagamentos)').all().some((c) => c.name === 'ref_pagamento');
colunaNova('mp_pagamentos', 'referencia TEXT');
colunaNova('mp_pagamentos', 'envio_id INTEGER');
colunaNova('mp_pagamentos', 'ref_pagamento INTEGER');
if (mpSemReferencia) db.prepare("DELETE FROM estado WHERE chave LIKE 'mp_lido_em:%'").run();
// Flex do ML: quais envios são Flex (envio_logistica) e o bônus Flex creditado por envio.
const lista_ = (xs) => xs.map(() => '?').join(',');
const flexDosEnvios = (envios) => (envios.length ? new Set(db.prepare(`SELECT envio_id FROM envio_logistica
  WHERE tipo='self_service' AND envio_id IN (${lista_(envios)})`).all(...envios).map((r) => r.envio_id)) : new Set());
const bonusFlexDosEnvios = (envios) => (envios.length ? Object.fromEntries(db.prepare(`SELECT envio_id, SUM(bruto) AS v FROM mp_pagamentos
  WHERE descricao='bonificaciones_flex' AND status='approved' AND envio_id IN (${lista_(envios)}) GROUP BY envio_id`).all(...envios)
  .map((r) => [r.envio_id, r.v])) : {});
// Bônus médio dos envios Flex da conta (90 dias), separado por "o vendedor tinha custo de envio
// no /costs" (frete grátis para o comprador: bônus ≈ R$ 1,10) ou não (comprador pagou: ≈ R$ 10).
const bonusFlexMedias = (mlUserId) => {
  const r = db.prepare(`SELECT (f.custo > 0) AS com_custo, AVG(p.bruto) AS media, COUNT(*) AS n FROM mp_pagamentos p
    JOIN fretes f ON f.envio_id = p.envio_id WHERE p.ml_user_id=? AND p.descricao='bonificaciones_flex' AND p.status='approved'
    AND p.criado >= ? GROUP BY 1`).all(mlUserId, new Date(Date.now() - 90 * 864e5).toISOString());
  return { com_custo: r.find((x) => x.com_custo === 1)?.media ?? null, sem_custo: r.find((x) => x.com_custo === 0)?.media ?? null };
};
// pedido de cada envio (bônus do Flex e frete pago à parte não trazem o pedido)
const mpPedidosDosEnvios = (envios) => (envios.length ? Object.fromEntries(db.prepare(`SELECT envio_id, MIN(order_id) AS order_id FROM vendas
  WHERE envio_id IN (${envios.map(() => '?').join(',')}) GROUP BY envio_id`).all(...envios).map((r) => [r.envio_id, r.order_id])) : {});
const mpPagamentosConta = (mlUserId) => db.prepare('SELECT * FROM mp_pagamentos WHERE (? IS NULL OR ml_user_id = ?) ORDER BY criado DESC')
  .all(mlUserId, mlUserId);

// Extrato do Mercado Pago (relatório de liberações): cada movimento que mexeu no saldo
// disponível — venda liberada, reserva por disputa, reembolso, saque… Cada relatório importado
// substitui os movimentos da sua janela (inicio..fim) e guarda o saldo inicial e final dela.
db.exec(`
  CREATE TABLE IF NOT EXISTS mp_extrato (
    ml_user_id INTEGER NOT NULL,
    data       TEXT NOT NULL,             -- ISO UTC
    source_id  TEXT,
    referencia TEXT,
    tipo       TEXT NOT NULL,             -- DESCRIPTION do relatório (payment, payout…)
    credito    REAL NOT NULL DEFAULT 0,
    debito     REAL NOT NULL DEFAULT 0,
    ordem      INTEGER NOT NULL           -- posição no relatório (desempate na mesma data)
  );
  CREATE INDEX IF NOT EXISTS mp_ext_conta_data ON mp_extrato(ml_user_id, data);
  CREATE TABLE IF NOT EXISTS mp_extrato_saldos (
    ml_user_id    INTEGER NOT NULL,
    inicio        TEXT NOT NULL,
    fim           TEXT NOT NULL,
    saldo_inicial REAL NOT NULL,
    saldo_final   REAL NOT NULL,
    importado     TEXT NOT NULL,
    PRIMARY KEY (ml_user_id, inicio)
  );
  CREATE TABLE IF NOT EXISTS mp_conferencia (
    chave      TEXT PRIMARY KEY,          -- pag:{id do pagamento} | venda:{order_id}
    ml_user_id INTEGER NOT NULL,
    order_id   INTEGER,                   -- venda ligada à mão
    observacao TEXT,
    conferido  INTEGER NOT NULL DEFAULT 0,
    atualizado TEXT NOT NULL
  );
`);
function mpExtratoImportar(mlUserId, { inicio, fim, saldo_inicial, saldo_final, linhas }) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM mp_extrato WHERE ml_user_id=? AND data >= ?').run(mlUserId, inicio);
    db.prepare('DELETE FROM mp_extrato_saldos WHERE ml_user_id=? AND inicio >= ?').run(mlUserId, inicio);
    const st = db.prepare('INSERT INTO mp_extrato (ml_user_id, data, source_id, referencia, tipo, credito, debito, ordem) VALUES (?,?,?,?,?,?,?,?)');
    linhas.forEach((l, i) => st.run(mlUserId, l.data, l.source_id, l.referencia, l.tipo, l.credito, l.debito, i));
    db.prepare(`INSERT OR REPLACE INTO mp_extrato_saldos (ml_user_id, inicio, fim, saldo_inicial, saldo_final, importado)
      VALUES (?,?,?,?,?,?)`).run(mlUserId, inicio, fim, saldo_inicial, saldo_final, agora());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const mpExtrato = (mlUserId) => db.prepare('SELECT * FROM mp_extrato WHERE ml_user_id=? ORDER BY data, ordem').all(mlUserId);
const mpExtratoSaldos = (mlUserId) => db.prepare('SELECT * FROM mp_extrato_saldos WHERE ml_user_id=? ORDER BY inicio').all(mlUserId);
const mpConferencias = () => Object.fromEntries(db.prepare('SELECT * FROM mp_conferencia').all().map((r) => [r.chave, r]));
function mpConferenciaGravar(chave, mlUserId, { order_id = null, observacao = null, conferido = false }) {
  if (!order_id && !observacao && !conferido) return db.prepare('DELETE FROM mp_conferencia WHERE chave=?').run(chave);
  return db.prepare(`INSERT OR REPLACE INTO mp_conferencia (chave, ml_user_id, order_id, observacao, conferido, atualizado)
    VALUES (?,?,?,?,?,?)`).run(chave, mlUserId, order_id, observacao, conferido ? 1 : 0, agora());
}
// Vendas da conta desde uma data, uma linha por pedido: valor dos itens, envio e o 1º anúncio.
const MP_VENDA_SQL = (onde) => `SELECT x.*, (SELECT p.title FROM produtos p WHERE p.item_id = x.item_id) AS titulo FROM (
    SELECT v.order_id, MIN(v.ml_user_id) AS ml_user_id, MIN(v.data) AS data, MAX(v.status) AS status,
      ROUND(SUM(v.preco_unit * v.quantidade), 2) AS itens, MAX(v.envio_id) AS envio_id, MIN(v.item_id) AS item_id
    FROM vendas v WHERE ${onde} GROUP BY v.order_id) x`;
const mpVendasDesde = (mlUserId, de) => db.prepare(MP_VENDA_SQL('v.ml_user_id=? AND v.data >= ?')).all(mlUserId, de);
// Os pedidos citados (ligação à mão, venda antiga, reclamação), em qualquer data.
const mpVendasDosPedidos = (ids) => (ids.length ? db.prepare(MP_VENDA_SQL(`v.order_id IN (${ids.map(() => '?').join(',')})`)).all(...ids) : []);

// ---------- concorrentes no Mercado Livre ----------
// A API do ML não deixa ler anúncio de outro vendedor: os concorrentes vêm da página de busca
// (scraper). Os "vendidos" que o ML mostra são o total da vida do anúncio, EM FAIXAS (25, 50,
// 100, 500, 1000…; medido em 01/10/2026): cada busca grava a faixa de cada concorrente para a
// tela mostrar quando ele subiu de faixa. ml_concorrentes = os que o vendedor marcou como
// "igual ao meu", com o último preço visto.
db.exec(`
  CREATE TABLE IF NOT EXISTS ml_conc_medidas (
    conc_item TEXT NOT NULL,
    vendidos  INTEGER,
    preco     REAL,
    medido_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ml_conc_med_item ON ml_conc_medidas(conc_item, medido_em);
  CREATE TABLE IF NOT EXISTS ml_concorrentes (
    ml_user_id     INTEGER NOT NULL,
    meu_item       TEXT NOT NULL,
    conc_item      TEXT NOT NULL,
    titulo         TEXT,
    vendedor       TEXT,
    imagem         TEXT,
    preco          REAL,
    preco_original REAL,
    vendidos       INTEGER,
    frete_gratis   INTEGER,
    visto_em       TEXT,
    marcado_em     TEXT NOT NULL,
    PRIMARY KEY (meu_item, conc_item)
  );
`);
function concMedidasGravar(lista) {
  const st = db.prepare('INSERT INTO ml_conc_medidas (conc_item, vendidos, preco, medido_em) VALUES (?,?,?,?)');
  const quando = agora();
  db.exec('BEGIN');
  try { for (const r of lista) st.run(r.item_id, r.vendidos ?? null, r.preco ?? null, quando); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const concMedidas = (concItem) =>
  db.prepare('SELECT vendidos, preco, medido_em FROM ml_conc_medidas WHERE conc_item=? ORDER BY medido_em').all(concItem);
const concMarcar = (mlUserId, meu, c) => db.prepare(`INSERT INTO ml_concorrentes (ml_user_id, meu_item, conc_item, titulo, vendedor, imagem,
    preco, preco_original, vendidos, frete_gratis, visto_em, marcado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(meu_item, conc_item) DO UPDATE SET titulo=excluded.titulo, vendedor=excluded.vendedor, imagem=excluded.imagem,
    preco=excluded.preco, preco_original=excluded.preco_original, vendidos=excluded.vendidos, frete_gratis=excluded.frete_gratis,
    visto_em=excluded.visto_em`)
  .run(mlUserId, meu, c.item_id, c.titulo ?? null, c.vendedor ?? null, c.imagem ?? null, c.preco ?? null, c.preco_original ?? null,
    c.vendidos ?? null, c.frete_gratis ? 1 : 0, agora(), agora());
// Atualiza o último preço/faixa dos marcados que apareceram numa busca.
function concAtualizar(meu, lista) {
  const st = db.prepare(`UPDATE ml_concorrentes SET preco=?, preco_original=?, vendidos=?, frete_gratis=?, visto_em=?
    WHERE meu_item=? AND conc_item=?`);
  for (const r of lista) st.run(r.preco ?? null, r.preco_original ?? null, r.vendidos ?? null, r.frete_gratis ? 1 : 0, agora(), meu, r.item_id);
}
const concDesmarcar = (meu, conc) => db.prepare('DELETE FROM ml_concorrentes WHERE meu_item=? AND conc_item=?').run(meu, conc);
const concDoItem = (meu) => db.prepare('SELECT * FROM ml_concorrentes WHERE meu_item=? ORDER BY preco').all(meu);
const concItensMarcados = (mlUserId) =>
  db.prepare('SELECT DISTINCT meu_item FROM ml_concorrentes WHERE ml_user_id=?').all(mlUserId).map((r) => r.meu_item);
const concResumo = (ids) => {
  if (!ids.length) return {};
  const q = db.prepare(`SELECT meu_item, COUNT(*) AS n, MIN(preco) AS menor, MAX(visto_em) AS visto_em
    FROM ml_concorrentes WHERE meu_item IN (${ids.map(() => '?').join(',')}) GROUP BY meu_item`).all(...ids);
  return Object.fromEntries(q.map((r) => [r.meu_item, { marcados: r.n, menor_preco: r.menor, visto_em: r.visto_em }]));
};

// ---------- Amazon: lançamentos financeiros (vendas, reembolsos, ajustes) ----------
// Cópia local do que a SP-API (finances/v0/financialEvents) lançou, um por item de pedido.
// Só valores, SKU e o número do pedido: nada do comprador (amazon.js#lancamentosDe).
db.exec(`
  CREATE TABLE IF NOT EXISTS amazon_lancamentos (
    chave      TEXT PRIMARY KEY,
    tipo       TEXT NOT NULL,      -- venda | reembolso | ajuste | etiqueta | servico
    pedido     TEXT,
    sku        TEXT,
    quantidade INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,      -- PostedDate (ISO)
    canal      TEXT,               -- FBA | proprio
    receita    REAL NOT NULL DEFAULT 0,   -- produto + frete cobrado + presente, menos promoções
    tarifa     REAL NOT NULL DEFAULT 0,   -- comissão, tarifa FBA etc. (positivo = custo)
    frete      REAL NOT NULL DEFAULT 0,   -- etiqueta/frete do envio próprio (positivo = custo)
    imposto_cobrado REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS amazon_lanc_data ON amazon_lancamentos(data);
`);
// tarifa_fixa = a parte da tarifa que é por unidade (FBA), já somada em `tarifa`. Coluna nova:
// a próxima leitura relê os 92 dias para preencher (a cópia é refeita por cima).
if (!db.prepare('PRAGMA table_info(amazon_lancamentos)').all().some((c) => c.name === 'tarifa_fixa')) {
  db.exec('ALTER TABLE amazon_lancamentos ADD COLUMN tarifa_fixa REAL NOT NULL DEFAULT 0');
  db.prepare("DELETE FROM estado WHERE chave='amazon_lanc_lido_em'").run();
}
// descricao = nome da cobrança avulsa (tipo 'etiqueta' | 'servico', amazon.js#servicosDe). Coluna nova:
// junto com ela a cópia dos 92 dias é relida — a chave das vendas com 2+ unidades do mesmo item
// mudou (amazon.js#lancamentosDe) e a leitura antiga gravava uma por cima da outra.
if (!db.prepare('PRAGMA table_info(amazon_lancamentos)').all().some((c) => c.name === 'descricao')) {
  db.exec('ALTER TABLE amazon_lancamentos ADD COLUMN descricao TEXT');
  db.prepare("DELETE FROM estado WHERE chave='amazon_lanc_lido_em'").run();
}
// promocoes = JSON [{id, tipo, valor}] das promoções da venda (PromotionList do financeiro; valor =
// desconto dado ao cliente). A releitura dos 92 dias é pela marca amazon_lanc_promocoes (amazon.js#sincronizar).
colunaNova('amazon_lancamentos', 'promocoes TEXT');
function amazonLancGravar(linhas) {
  const st = db.prepare(`INSERT INTO amazon_lancamentos (chave, tipo, pedido, sku, quantidade, data, canal, receita, tarifa, frete, imposto_cobrado, tarifa_fixa, descricao, promocoes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chave) DO UPDATE SET tipo=excluded.tipo, pedido=excluded.pedido, sku=excluded.sku, quantidade=excluded.quantidade,
      data=excluded.data, canal=excluded.canal, receita=excluded.receita, tarifa=excluded.tarifa, frete=excluded.frete,
      imposto_cobrado=excluded.imposto_cobrado, tarifa_fixa=excluded.tarifa_fixa, descricao=excluded.descricao, promocoes=excluded.promocoes`);
  db.exec('BEGIN');
  try {
    for (const l of linhas) st.run(l.chave, l.tipo, l.pedido, l.sku, l.quantidade, l.data, l.canal, l.receita, l.tarifa, l.frete, l.imposto_cobrado, l.tarifa_fixa || 0, l.descricao || null,
      l.promocoes?.length ? JSON.stringify(l.promocoes) : null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return linhas.length;
}
// Pedidos da Amazon (Orders API): data da compra, situação e os itens (SKU, quantidade e
// preço). Sem nada do comprador. Os itens são uma chamada por pedido (lidos aos poucos).
db.exec(`
  CREATE TABLE IF NOT EXISTS amazon_pedidos (
    pedido      TEXT PRIMARY KEY,
    data        TEXT NOT NULL,      -- PurchaseDate (ISO)
    status      TEXT,
    canal       TEXT,               -- FBA | proprio
    total       REAL,
    atualizado  TEXT,
    itens_lidos INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS amazon_ped_data ON amazon_pedidos(data);
  CREATE TABLE IF NOT EXISTS amazon_itens (
    pedido        TEXT NOT NULL,
    item_id       TEXT NOT NULL,
    sku           TEXT,
    asin          TEXT,
    quantidade    INTEGER NOT NULL DEFAULT 0,
    preco         REAL,              -- ItemPrice: total da linha (todas as unidades)
    frete_cobrado REAL NOT NULL DEFAULT 0,
    desconto      REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (pedido, item_id)
  );
`);
// Pedido que estava pendente (sem preço nos itens) e mudou de situação: lê os itens de novo.
const PENDENTES_AMZ = "('Pending','PendingAvailability')";
function amazonPedidosGravar(lista) {
  const st = db.prepare(`INSERT INTO amazon_pedidos (pedido, data, status, canal, total, atualizado) VALUES (?,?,?,?,?,?)
    ON CONFLICT(pedido) DO UPDATE SET data=excluded.data, status=excluded.status, canal=excluded.canal, total=excluded.total,
      atualizado=excluded.atualizado,
      itens_lidos=CASE WHEN amazon_pedidos.status IN ${PENDENTES_AMZ} AND excluded.status NOT IN ${PENDENTES_AMZ} THEN 0 ELSE amazon_pedidos.itens_lidos END`);
  db.exec('BEGIN');
  try { for (const p of lista) st.run(p.pedido, p.data, p.status, p.canal, p.total, p.atualizado); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
const amazonPedidosSemItens = (limite) =>
  db.prepare("SELECT pedido FROM amazon_pedidos WHERE itens_lidos=0 AND status<>'Canceled' ORDER BY data DESC LIMIT ?").all(limite).map((r) => r.pedido);
function amazonItensGravar(pedido, itens) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM amazon_itens WHERE pedido=?').run(pedido);
    const st = db.prepare('INSERT INTO amazon_itens (pedido, item_id, sku, asin, quantidade, preco, frete_cobrado, desconto) VALUES (?,?,?,?,?,?,?,?)');
    for (const i of itens) st.run(pedido, i.item_id, i.sku, i.asin, i.quantidade, i.preco, i.frete_cobrado, i.desconto);
    db.prepare('UPDATE amazon_pedidos SET itens_lidos=1 WHERE pedido=?').run(pedido);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Linhas de venda (um item de pedido por linha; pedido sem itens lidos vem com sku NULL).
const amazonVendasPeriodo = (de, ate) => db.prepare(`
  SELECT p.pedido, p.data, p.status, p.canal, p.total, p.itens_lidos, i.item_id, i.sku, i.asin, i.quantidade, i.preco,
         i.frete_cobrado, i.desconto
  FROM amazon_pedidos p LEFT JOIN amazon_itens i ON i.pedido = p.pedido
  WHERE p.data >= ? AND p.data < ? ORDER BY p.data DESC`).all(de, ate);
// Último preço por unidade (já com o desconto) de cada SKU, por canal ("sku|FBA") e geral ("sku"):
// estima o pedido "Pending", que a Amazon manda sem preço até confirmar o pagamento.
function amazonUltimoPrecoPorSku() {
  const m = new Map();
  for (const r of db.prepare(`SELECT i.sku, p.canal, (i.preco - i.desconto) * 1.0 / i.quantidade AS u FROM amazon_itens i
      JOIN amazon_pedidos p ON p.pedido = i.pedido WHERE i.preco IS NOT NULL AND i.quantidade > 0 AND i.sku IS NOT NULL
      AND p.status <> 'Canceled' ORDER BY p.data`).all()) {
    m.set(`${r.sku}|${r.canal}`, Math.round(r.u * 100) / 100);
    m.set(r.sku, Math.round(r.u * 100) / 100);
  }
  return m;
}
// Unidades, faturamento e pedidos por SKU e canal (FBA x próprio) desde uma data (tela Full).
const amazonUnidadesPorSku = (desde) => db.prepare(`
  SELECT i.sku, p.canal, SUM(i.quantidade) AS u, SUM(COALESCE(i.preco,0) + i.frete_cobrado - i.desconto) AS f,
         COUNT(DISTINCT p.pedido) AS p
  FROM amazon_pedidos p JOIN amazon_itens i ON i.pedido = p.pedido
  WHERE p.data >= ? AND p.status <> 'Canceled' AND i.sku IS NOT NULL GROUP BY i.sku, p.canal`).all(desde);
const amazonItensSemFoto = () => db.prepare(`SELECT i.sku, MAX(i.asin) AS asin FROM amazon_itens i
  LEFT JOIN amazon_fotos f ON f.sku = i.sku WHERE i.sku IS NOT NULL AND i.asin IS NOT NULL AND f.sku IS NULL GROUP BY i.sku`).all();

// Concorrência de cada ASIN (quantas ofertas, a mais barata dos outros, quem tem o destaque),
// para o filtro "com concorrentes" da tela Anúncios. Relida a cada 6 h.
db.exec(`
  CREATE TABLE IF NOT EXISTS amazon_concorrencia (
    asin          TEXT PRIMARY KEY,
    total_ofertas INTEGER,
    outros        INTEGER,
    menor_outro   REAL,
    destaque      REAL,
    voce_destaque INTEGER,
    lido_em       TEXT NOT NULL
  );
`);
const amazonConcGravar = (asin, c) => db.prepare(`INSERT INTO amazon_concorrencia (asin, total_ofertas, outros, menor_outro, destaque, voce_destaque, lido_em)
  VALUES (?,?,?,?,?,?,?) ON CONFLICT(asin) DO UPDATE SET total_ofertas=excluded.total_ofertas, outros=excluded.outros,
  menor_outro=excluded.menor_outro, destaque=excluded.destaque, voce_destaque=excluded.voce_destaque, lido_em=excluded.lido_em`)
  .run(asin, c.total_ofertas ?? null, c.ofertas.filter((o) => !o.voce).length, c.menor_outro?.total ?? null,
    c.destaque?.total ?? null, c.voce_destaque ? 1 : 0, agora());
// Nome dos vendedores concorrentes, digitado pelo vendedor (a API só dá o código; o nome
// aparece na página pública da loja, que ele mesmo abre pelo link).
db.exec(`CREATE TABLE IF NOT EXISTS amazon_vendedores (seller_id TEXT PRIMARY KEY, nome TEXT NOT NULL, gravado_em TEXT NOT NULL)`);
const amazonVendedorNomear = (id, nome) => (nome
  ? db.prepare(`INSERT INTO amazon_vendedores (seller_id, nome, gravado_em) VALUES (?,?,?)
      ON CONFLICT(seller_id) DO UPDATE SET nome=excluded.nome, gravado_em=excluded.gravado_em`).run(id, nome, agora())
  : db.prepare('DELETE FROM amazon_vendedores WHERE seller_id=?').run(id));
const amazonVendedoresNomes = () => new Map(db.prepare('SELECT seller_id, nome FROM amazon_vendedores').all().map((r) => [r.seller_id, r.nome]));
const amazonConcorrencia = () => new Map(db.prepare('SELECT * FROM amazon_concorrencia').all().map((c) => [c.asin, c]));

// Foto de cada SKU (ASIN pelo item do pedido, foto principal pelo catálogo). foto NULL com
// lido_em = tentou e não achou (tenta de novo depois de 7 dias).
db.exec(`
  CREATE TABLE IF NOT EXISTS amazon_fotos (
    sku     TEXT PRIMARY KEY,
    asin    TEXT,
    foto    TEXT,
    lido_em TEXT NOT NULL
  );
`);
const amazonFotoGravar = (sku, asin, foto) =>
  db.prepare(`INSERT INTO amazon_fotos (sku, asin, foto, lido_em) VALUES (?,?,?,?)
              ON CONFLICT(sku) DO UPDATE SET asin=excluded.asin, foto=excluded.foto, lido_em=excluded.lido_em`).run(sku, asin, foto, agora());
const amazonFotos = () => new Map(db.prepare('SELECT * FROM amazon_fotos').all().map((f) => [f.sku, f]));
const amazonLancPeriodo = (de, ate) =>
  db.prepare('SELECT * FROM amazon_lancamentos WHERE data >= ? AND data < ? ORDER BY data').all(de, ate);
const amazonLancApagar = () => {
  for (const t of ['amazon_lancamentos', 'amazon_fotos', 'amazon_pedidos', 'amazon_itens']) db.prepare(`DELETE FROM ${t}`).run();
};

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
const CONFIG_SECRETA = new Set(['ml_client_secret', 'shopee_partner_key', 'painel_2fa_segredo', 'painel_2fa_pendente',
  'amazon_lwa_client_secret', 'amazon_refresh_token', 'amzads_client_secret', 'amzads_refresh_token', 'leroy_api_key',
  'magalu_client_secret', 'magalu_refresh_token']);

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
  configGravar('painel_senha_em', agora());   // validade de 365 dias (seguranca.js)
  configGravar('painel_senha_fraca', null);    // a nova já passou pela política
  db.prepare('DELETE FROM sessoes WHERE usuario_id IS NULL').run(); // senha nova derruba quem estava logado
}

const senhaDefinida = () => !!configLer('painel_senha');

const senhaConfere = (senha) => hashConfere(configLer('painel_senha'), senha);
function hashDeSenha(senha) {
  const sal = crypto.randomBytes(16);
  return `scrypt:${sal.toString('base64')}:${crypto.scryptSync(String(senha), sal, 64).toString('base64')}`;
}
function hashConfere(guardado, senha) {
  const [tipo, sal, hash] = String(guardado || '').split(':');
  if (tipo !== 'scrypt' || !sal || !hash) return false;
  const esperado = Buffer.from(hash, 'base64');
  const obtido = crypto.scryptSync(String(senha), Buffer.from(sal, 'base64'), esperado.length);
  return crypto.timingSafeEqual(obtido, esperado);
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOKEN = /^[a-f0-9]{64}$/;

// usuarioId null = o administrador (a senha do primeiro acesso).
function sessaoCriar(dias = 7, usuarioId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes (token_hash, criada_em, expira_em, usuario_id) VALUES (?,?,?,?)')
    .run(hashToken(token), agora(), Date.now() + dias * 864e5, usuarioId);
  return token;
}
// A sessão do cookie: { sessao (hash), usuario_id, conta_ativa } ou null.
function sessaoDe(token) {
  if (!TOKEN.test(token || '')) return null;
  const h = hashToken(token);
  const s = db.prepare('SELECT usuario_id, conta_ativa, expira_em FROM sessoes WHERE token_hash=?').get(h);
  return s && s.expira_em > Date.now() ? { sessao: h, usuario_id: s.usuario_id ?? null, conta_ativa: s.conta_ativa ?? null } : null;
}

// ---------- usuários do painel (usuarios.js) ----------
// Senha em scrypt com sal, como a do administrador; chave do 2FA cifrada. "temporaria" = criada pelo
// administrador: vale 72 h e o 1º login manda trocar.
for (const col of ['usuario_id INTEGER', 'conta_ativa TEXT']) { try { db.exec(`ALTER TABLE sessoes ADD COLUMN ${col}`); } catch { /* já existe */ } }
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    modulos TEXT NOT NULL DEFAULT '[]',
    ativo INTEGER NOT NULL DEFAULT 1,
    senha TEXT, senha_em TEXT, senha_temporaria INTEGER NOT NULL DEFAULT 1,
    mfa_segredo TEXT, mfa_pendente TEXT, mfa_em TEXT,
    criado_em TEXT NOT NULL, ultimo_acesso TEXT
  );
  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    em TEXT NOT NULL, quem TEXT NOT NULL, metodo TEXT NOT NULL, caminho TEXT NOT NULL, status INTEGER
  );
`);
const usuarioDe = (u) => u && ({ id: u.id, login: u.login, nome: u.nome, modulos: JSON.parse(u.modulos || '[]'), ativo: !!u.ativo,
  senha_em: u.senha_em, senha_temporaria: !!u.senha_temporaria, mfa_ativo: !!u.mfa_segredo, mfa_em: u.mfa_em,
  criado_em: u.criado_em, ultimo_acesso: u.ultimo_acesso });
const usuariosListar = () => db.prepare('SELECT * FROM usuarios ORDER BY nome').all().map(usuarioDe);
const usuarioObter = (id) => usuarioDe(db.prepare('SELECT * FROM usuarios WHERE id=?').get(id));
const usuarioPorLogin = (login) => usuarioDe(db.prepare('SELECT * FROM usuarios WHERE login=?').get(String(login || '').trim().toLowerCase()));
function usuarioCriar({ login, nome, modulos }, senhaTemp) {
  if (usuarioPorLogin(login)) throw Object.assign(new Error('Já existe um usuário com esse login.'), { status: 400 });
  const r = db.prepare('INSERT INTO usuarios (login, nome, modulos, senha, senha_em, senha_temporaria, criado_em) VALUES (?,?,?,?,?,1,?)')
    .run(login, nome, JSON.stringify(modulos || []), hashDeSenha(senhaTemp), agora(), agora());
  return Number(r.lastInsertRowid);
}
function usuarioAtualizar(id, { nome, modulos, ativo }) {
  db.prepare('UPDATE usuarios SET nome=?, modulos=?, ativo=? WHERE id=?').run(nome, JSON.stringify(modulos || []), ativo ? 1 : 0, id);
  if (!ativo) usuarioSessoesApagar(id);
}
const usuarioSessoesApagar = (id) => db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(id);
function usuarioSenhaDefinir(id, senha, temporaria = false) {
  db.prepare('UPDATE usuarios SET senha=?, senha_em=?, senha_temporaria=? WHERE id=?').run(hashDeSenha(senha), agora(), temporaria ? 1 : 0, id);
  usuarioSessoesApagar(id);   // senha nova derruba as sessões dele
}
const usuarioSenhaConfere = (id, senha) => hashConfere(db.prepare('SELECT senha FROM usuarios WHERE id=?').get(id)?.senha, senha);
function usuarioMfa(id) {
  const u = db.prepare('SELECT mfa_segredo, mfa_pendente FROM usuarios WHERE id=?').get(id);
  return { segredo: decifrar(u?.mfa_segredo ?? null), pendente: decifrar(u?.mfa_pendente ?? null) };
}
function usuarioMfaGravar(id, { segredo, pendente }) {
  db.prepare('UPDATE usuarios SET mfa_segredo=?, mfa_pendente=?, mfa_em=? WHERE id=?')
    .run(cifrar(segredo ?? null), cifrar(pendente ?? null), segredo ? agora() : null, id);
}
const usuarioAcessou = (id) => db.prepare('UPDATE usuarios SET ultimo_acesso=? WHERE id=?').run(agora(), id);
function usuarioRemover(id) { usuarioSessoesApagar(id); db.prepare('DELETE FROM usuarios WHERE id=?').run(id); }
// Registro de quem fez o quê (só o método e o caminho; o corpo pode ter segredo). Guarda 1 ano.
function auditoriaGravar(quem, metodo, caminho, status) {
  db.prepare('INSERT INTO auditoria (em, quem, metodo, caminho, status) VALUES (?,?,?,?,?)').run(agora(), quem, metodo, String(caminho).slice(0, 200), status);
  if (Math.random() < 0.01) db.prepare('DELETE FROM auditoria WHERE em < ?').run(new Date(Date.now() - 366 * 864e5).toISOString());
}
const auditoriaListar = (n = 300) => db.prepare('SELECT em, quem, metodo, caminho, status FROM auditoria ORDER BY id DESC LIMIT ?').all(n);

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

// Leroy Merlin (Mirakl, leroy.js): pedidos já sem dado de comprador (leroy.js#pedidoDe; as linhas
// vão em JSON), transações do repasse (TL02) e ciclos de pagamento (IV01 AUTO_INVOICE).
db.exec(`
  CREATE TABLE IF NOT EXISTS leroy_pedidos (
    order_id    TEXT PRIMARY KEY,
    data        TEXT,
    status      TEXT,
    atualizado  TEXT,
    linhas      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS leroy_ped_data ON leroy_pedidos(data);
  CREATE TABLE IF NOT EXISTS leroy_transacoes (
    id       TEXT PRIMARY KEY,
    data     TEXT,
    tipo     TEXT,
    estado   TEXT,
    valor    REAL,
    pedido   TEXT,
    linha    TEXT,
    ciclo    TEXT
  );
  CREATE INDEX IF NOT EXISTS leroy_tr_linha ON leroy_transacoes(linha);
  CREATE TABLE IF NOT EXISTS leroy_ciclos (
    id          TEXT PRIMARY KEY,
    inicio      TEXT,
    fim         TEXT,
    previsto    TEXT,
    valor       REAL,
    vendas      REAL,
    comissao    REAL,
    reembolsos  REAL,
    assinatura  REAL,
    estado      TEXT
  );
`);
// Nome do cliente (só nome e sobrenome, para a busca e a lista de Pedidos, como no ML) e foto do
// produto nas linhas: coluna nova = relê os 152 dias para preencher os pedidos já copiados.
if (!db.prepare('PRAGMA table_info(leroy_pedidos)').all().some((c) => c.name === 'cliente')) {
  colunaNova('leroy_pedidos', 'cliente TEXT');
  db.prepare("DELETE FROM estado WHERE chave='leroy_lido_em'").run();
}
function leroyPedidosGravar(lista) {
  const st = db.prepare(`INSERT INTO leroy_pedidos (order_id, data, status, atualizado, linhas, cliente) VALUES (?,?,?,?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET data=excluded.data, status=excluded.status, atualizado=excluded.atualizado, linhas=excluded.linhas,
      cliente=COALESCE(excluded.cliente, leroy_pedidos.cliente)`);
  db.exec('BEGIN');
  try { for (const p of lista) st.run(p.order_id, p.data, p.status, p.atualizado, JSON.stringify(p.linhas), p.cliente ?? null); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
const leroyPedidosPeriodo = (de, ate) => db.prepare('SELECT * FROM leroy_pedidos WHERE data >= ? AND data < ? ORDER BY data DESC')
  .all(de, ate).map((p) => ({ ...p, linhas: JSON.parse(p.linhas) }));
function leroyTransacoesGravar(lista) {
  const st = db.prepare(`INSERT INTO leroy_transacoes (id, data, tipo, estado, valor, pedido, linha, ciclo) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET estado=excluded.estado, valor=excluded.valor, ciclo=excluded.ciclo`);
  db.exec('BEGIN');
  try { for (const t of lista) st.run(t.id, t.data, t.tipo, t.estado, t.valor, t.pedido, t.linha, t.ciclo); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
const leroyTransacoes = (desde = '') => db.prepare('SELECT * FROM leroy_transacoes WHERE data >= ? ORDER BY data').all(desde);
// a transação mais antiga ainda não paga: a próxima leitura começa nela (pode mudar de situação)
const leroyMaisAntigaAberta = () => db.prepare("SELECT MIN(data) d FROM leroy_transacoes WHERE estado <> 'PAID'").get()?.d || null;
function leroyCiclosGravar(lista) {
  const st = db.prepare(`INSERT INTO leroy_ciclos (id, inicio, fim, previsto, valor, vendas, comissao, reembolsos, assinatura, estado) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET previsto=excluded.previsto, valor=excluded.valor, vendas=excluded.vendas, comissao=excluded.comissao,
      reembolsos=excluded.reembolsos, assinatura=excluded.assinatura, estado=excluded.estado`);
  db.exec('BEGIN');
  try { for (const c of lista) st.run(c.id, c.inicio, c.fim, c.previsto, c.valor, c.vendas, c.comissao, c.reembolsos, c.assinatura, c.estado); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
const leroyCiclos = () => db.prepare('SELECT * FROM leroy_ciclos ORDER BY fim DESC').all();
// Frete de cada pedido digitado pelo vendedor (o que pagou no Melhor Envio). Fica mesmo se a loja
// for desconectada: é dado do vendedor, não da Leroy.
db.exec(`CREATE TABLE IF NOT EXISTS leroy_fretes (order_id TEXT PRIMARY KEY, valor REAL NOT NULL, em TEXT NOT NULL)`);
function leroyFreteGravar(orderId, valor) {
  if (valor == null) db.prepare('DELETE FROM leroy_fretes WHERE order_id=?').run(orderId);
  else db.prepare(`INSERT INTO leroy_fretes (order_id, valor, em) VALUES (?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET valor=excluded.valor, em=excluded.em`).run(orderId, valor, new Date().toISOString());
}
const leroyFretes = () => new Map(db.prepare('SELECT order_id, valor FROM leroy_fretes').all().map((r) => [r.order_id, r.valor]));
const leroyPedidoExiste = (orderId) => !!db.prepare('SELECT 1 FROM leroy_pedidos WHERE order_id=?').get(orderId);
function leroyApagarTudo() { db.exec('DELETE FROM leroy_pedidos; DELETE FROM leroy_transacoes; DELETE FROM leroy_ciclos;'); }

// Magalu (magalu.js): pedidos (itens sem dado do comprador, em JSON) e a análise financeira de
// cada pedido (transações, em JSON). Chave = código do pedido.
db.exec(`
  CREATE TABLE IF NOT EXISTS magalu_pedidos (
    code        TEXT PRIMARY KEY,
    data        TEXT,
    status      TEXT,
    atualizado  TEXT,
    entregue    TEXT,
    frete_cliente REAL,
    comissao    REAL,
    itens       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS magalu_ped_data ON magalu_pedidos(data);
  CREATE TABLE IF NOT EXISTS magalu_financeiro (
    code        TEXT PRIMARY KEY,
    atualizado  TEXT,
    transacoes  TEXT NOT NULL
  );
`);
function magaluPedidosGravar(lista) {
  const st = db.prepare(`INSERT INTO magalu_pedidos (code, data, status, atualizado, entregue, frete_cliente, comissao, itens) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET data=excluded.data, status=excluded.status, atualizado=excluded.atualizado, entregue=excluded.entregue,
      frete_cliente=excluded.frete_cliente, comissao=excluded.comissao, itens=excluded.itens`);
  db.exec('BEGIN');
  try { for (const p of lista) st.run(p.code, p.data, p.status, p.atualizado, p.entregue, p.frete_cliente, p.comissao, JSON.stringify(p.itens)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
function magaluFinanceiroGravar(lista) {
  const st = db.prepare(`INSERT INTO magalu_financeiro (code, atualizado, transacoes) VALUES (?,?,?)
    ON CONFLICT(code) DO UPDATE SET atualizado=excluded.atualizado, transacoes=excluded.transacoes`);
  db.exec('BEGIN');
  try { for (const f of lista) st.run(f.code, f.atualizado, JSON.stringify(f.transacoes)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return lista.length;
}
const magaluPedidosPeriodo = (de, ate) => db.prepare('SELECT * FROM magalu_pedidos WHERE data >= ? AND data < ? ORDER BY data DESC')
  .all(de, ate).map((p) => ({ ...p, itens: JSON.parse(p.itens) }));
function magaluFinanceiroDe(codes) {
  const m = new Map();
  const st = db.prepare('SELECT code, transacoes FROM magalu_financeiro WHERE code = ?');
  for (const c of codes) { const r = st.get(c); if (r) m.set(c, JSON.parse(r.transacoes)); }
  return m;
}
function magaluApagarTudo() { db.exec('DELETE FROM magalu_pedidos; DELETE FROM magalu_financeiro; DELETE FROM magalu_anuncios;'); }

// Anúncios da Magalu (portfolios/skus + preço + estoque, um SKU por chamada; relidos em segundo plano)
// e o vínculo SKU do canal -> SKU do painel, digitado pelo vendedor quando o anúncio usa outro código
// (ex.: 15850067167 na Magalu = KIT-630 no painel). Serve para achar o custo do produto.
db.exec(`
  CREATE TABLE IF NOT EXISTS magalu_anuncios (
    sku         TEXT PRIMARY KEY,
    titulo      TEXT,
    status      TEXT,
    ativo       INTEGER,
    preco       REAL,
    preco_lista REAL,
    estoque     INTEGER,
    url         TEXT,
    lido_preco  TEXT,
    visto_em    TEXT
  );
  CREATE TABLE IF NOT EXISTS sku_vinculos (
    canal       TEXT NOT NULL,
    sku         TEXT NOT NULL,
    sku_painel  TEXT NOT NULL,
    em          TEXT NOT NULL,
    PRIMARY KEY (canal, sku)
  );
`);
function magaluAnunciosGravar(lista, visto) {
  const st = db.prepare(`INSERT INTO magalu_anuncios (sku, titulo, status, ativo, url, visto_em) VALUES (?,?,?,?,?,?)
    ON CONFLICT(sku) DO UPDATE SET titulo=excluded.titulo, status=excluded.status, ativo=excluded.ativo, url=excluded.url, visto_em=excluded.visto_em`);
  db.exec('BEGIN');
  try { for (const a of lista) st.run(a.sku, a.titulo, a.status, a.ativo ? 1 : 0, a.url, visto); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const magaluAnunciosLimparAntes = (visto) => db.prepare('DELETE FROM magalu_anuncios WHERE visto_em < ?').run(visto);
const magaluPrecoGravar = (sku, preco, lista, estoque) => db.prepare('UPDATE magalu_anuncios SET preco=?, preco_lista=?, estoque=?, lido_preco=? WHERE sku=?')
  .run(preco, lista, estoque, new Date().toISOString(), sku);
// sem preço lido ou lido há mais de 6 h; publicados primeiro
const magaluSemPreco = (limite) => db.prepare(`SELECT sku FROM magalu_anuncios WHERE lido_preco IS NULL OR lido_preco < ?
  ORDER BY (status = 'PUBLISHED') DESC, lido_preco IS NOT NULL, sku LIMIT ?`).all(new Date(Date.now() - 6 * 3600e3).toISOString(), limite).map((r) => r.sku);
const magaluAnuncios = () => db.prepare('SELECT * FROM magalu_anuncios ORDER BY titulo').all();
const skuVinculos = (canal) => new Map(db.prepare('SELECT sku, sku_painel FROM sku_vinculos WHERE canal=?').all(canal).map((r) => [r.sku, r.sku_painel]));
function skuVinculoGravar(canal, sku, skuPainel) {
  if (!skuPainel) return db.prepare('DELETE FROM sku_vinculos WHERE canal=? AND sku=?').run(canal, sku);
  db.prepare(`INSERT INTO sku_vinculos (canal, sku, sku_painel, em) VALUES (?,?,?,?)
    ON CONFLICT(canal, sku) DO UPDATE SET sku_painel=excluded.sku_painel, em=excluded.em`).run(canal, sku, skuPainel, new Date().toISOString());
}

// Comandas de separação (comandas.js): uma por envio pendente, numerada por categoria e dia. Do
// cliente, só o nome (vai impresso na comanda, para as câmeras da expedição).
db.exec(`
  CREATE TABLE IF NOT EXISTS comandas (
    chave       TEXT PRIMARY KEY,
    categoria   TEXT NOT NULL,
    dia         TEXT NOT NULL,
    numero      INTEGER NOT NULL,
    dados       TEXT NOT NULL,
    criada_em   TEXT NOT NULL,
    impressa_em TEXT,
    impressoes  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS comandas_dia ON comandas(dia, categoria);
`);
const COMANDA_DADOS = ['canal', 'loja', 'pedido', 'pedidos', 'envio', 'cliente', 'prazo', 'itens', 'etapa', 'comprado_em'];
const dadosComanda = (x) => JSON.stringify(Object.fromEntries(COMANDA_DADOS.map((k) => [k, x[k] ?? null])));
function comandasDe(chaves) {
  const st = db.prepare('SELECT 1 FROM comandas WHERE chave=?');
  return new Set(chaves.filter((c) => st.get(c)));
}
const comandasDoDia = (dia) => db.prepare('SELECT categoria, dia, numero FROM comandas WHERE dia=?').all(dia);
function comandasCriar(lista) {
  const st = db.prepare('INSERT OR IGNORE INTO comandas (chave, categoria, dia, numero, dados, criada_em) VALUES (?,?,?,?,?,?)');
  const agora = new Date().toISOString();
  db.exec('BEGIN');
  try { for (const x of lista) st.run(x.chave, x.categoria, x.dia, x.numero, dadosComanda(x), agora); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function comandasAtualizar(lista) {
  const st = db.prepare('UPDATE comandas SET dados=? WHERE chave=?');
  db.exec('BEGIN');
  try { for (const x of lista) st.run(dadosComanda(x), x.chave); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function comandasListar(chaves) {
  const st = db.prepare('SELECT * FROM comandas WHERE chave=?');
  return chaves.map((c) => st.get(c)).filter(Boolean).map((r) => ({ chave: r.chave, categoria: r.categoria, dia: r.dia, numero: r.numero,
    criada_em: r.criada_em, impressa_em: r.impressa_em, impressoes: r.impressoes, ...JSON.parse(r.dados) }));
}
// Comanda de um dia anterior que não foi impressa ganha o número de hoje (a impressa mantém o do papel).
function comandasRenumerar(lista) {
  const st = db.prepare('UPDATE comandas SET dia=?, numero=? WHERE chave=? AND impressa_em IS NULL');
  db.exec('BEGIN');
  try { for (const x of lista) st.run(x.dia, x.numero, x.chave); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function comandasImpressas(chaves, impressa) {
  const marcar = db.prepare('UPDATE comandas SET impressa_em=?, impressoes=impressoes+1 WHERE chave=?');
  const desmarcar = db.prepare('UPDATE comandas SET impressa_em=NULL WHERE chave=?');
  const agora = new Date().toISOString();
  db.exec('BEGIN');
  try { for (const c of chaves) { if (impressa) marcar.run(agora, c); else desmarcar.run(c); } db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- estoque (estoque.js) ----------
// Saldo = soma de estoque_mov com historico=0 (o que aconteceu depois da 1ª contagem). O histórico
// importado da planilha (historico=1) só serve para a média de saída, o custo médio e os relatórios.
// qtd tem sinal: + entra, - sai. ref liga o movimento à origem (venda:ml:…, compra:12, comanda:manual:3)
// e é por ela que a baixa automática confere o que já lançou (sem lançar duas vezes).
db.exec(`
  CREATE TABLE IF NOT EXISTS estoque_produtos (
    numero INTEGER PRIMARY KEY, situacao TEXT, classificacao TEXT, ref_compra TEXT, fornecedor TEXT, atualizado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS fornecedores (
    nome TEXT PRIMARY KEY, representante TEXT, telefone TEXT, endereco TEXT, prazo_meses REAL
  );
  CREATE TABLE IF NOT EXISTS estoque_mov (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL, tipo TEXT NOT NULL, numero INTEGER NOT NULL, qtd INTEGER NOT NULL,
    valor_unit REAL, origem TEXT, ref TEXT, historico INTEGER NOT NULL DEFAULT 0,
    quem TEXT, obs TEXT, desfeito INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS estoque_mov_num ON estoque_mov(numero, historico);
  CREATE INDEX IF NOT EXISTS estoque_mov_ref ON estoque_mov(ref);
  CREATE INDEX IF NOT EXISTS estoque_mov_data ON estoque_mov(data);
  CREATE TABLE IF NOT EXISTS estoque_contagem (
    numero INTEGER PRIMARY KEY, contado INTEGER NOT NULL, quem TEXT, em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido TEXT NOT NULL, data TEXT NOT NULL, fornecedor TEXT, numero INTEGER NOT NULL, qtd INTEGER NOT NULL,
    previsao TEXT, status TEXT NOT NULL DEFAULT 'aberto', recebido_qtd INTEGER NOT NULL DEFAULT 0,
    valor_pago REAL, recebido_em TEXT, obs TEXT, da_planilha INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS compras_pedido ON compras(pedido);
`);
try { db.exec('ALTER TABLE comandas ADD COLUMN concluida_em TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE fornecedores ADD COLUMN situacao TEXT'); } catch { /* já existe */ }

const estoqueProdutos = () => db.prepare('SELECT * FROM estoque_produtos').all();
function estoqueProdutoGravar(numero, p) {
  db.prepare(`INSERT INTO estoque_produtos (numero, situacao, classificacao, ref_compra, fornecedor, atualizado_em) VALUES (?,?,?,?,?,?)
    ON CONFLICT(numero) DO UPDATE SET situacao=excluded.situacao, classificacao=excluded.classificacao, ref_compra=excluded.ref_compra,
    fornecedor=excluded.fornecedor, atualizado_em=excluded.atualizado_em`)
    .run(numero, p.situacao ?? null, p.classificacao ?? null, p.ref_compra ?? null, p.fornecedor ?? null, agora());
}
const fornecedoresListar = () => db.prepare('SELECT * FROM fornecedores ORDER BY nome COLLATE NOCASE').all();
function fornecedorGravar(f) {
  db.prepare(`INSERT INTO fornecedores (nome, representante, telefone, endereco, prazo_meses, situacao) VALUES (?,?,?,?,?,?)
    ON CONFLICT(nome) DO UPDATE SET representante=excluded.representante, telefone=excluded.telefone, endereco=excluded.endereco,
    prazo_meses=excluded.prazo_meses, situacao=excluded.situacao`)
    .run(f.nome, f.representante ?? null, f.telefone ?? null, f.endereco ?? null, f.prazo_meses ?? null, f.situacao || 'Ativo');
}
const fornecedorRemover = (nome) => db.prepare('DELETE FROM fornecedores WHERE nome=?').run(nome);

// Movimentos: lista [{data, tipo, numero, qtd, valor_unit, origem, ref, historico, quem, obs}], numa transação.
function estoqueMovGravar(lista) {
  const st = db.prepare(`INSERT INTO estoque_mov (data, tipo, numero, qtd, valor_unit, origem, ref, historico, quem, obs, criado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const em = agora();
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const m of lista) ids.push(Number(st.run(m.data, m.tipo, m.numero, m.qtd, m.valor_unit ?? null, m.origem ?? null, m.ref ?? null,
      m.historico ? 1 : 0, m.quem ?? null, m.obs ?? null, em).lastInsertRowid));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids;
}
// Troca TODO o histórico importado (importar de novo a planilha não duplica).
function estoqueHistoricoTrocar(lista) {
  db.exec('BEGIN');
  try { db.prepare('DELETE FROM estoque_mov WHERE historico=1').run(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return estoqueMovGravar(lista.map((m) => ({ ...m, historico: 1 }))).length;
}
const estoqueSaldos = () => new Map(db.prepare('SELECT numero, SUM(qtd) s FROM estoque_mov WHERE historico=0 AND desfeito=0 GROUP BY numero').all().map((r) => [r.numero, r.s]));
// Para a reposição e o custo médio: por produto, saídas (sem ajustes) desde `de` e entradas com valor.
function estoqueResumoMov(de) {
  return db.prepare(`SELECT numero,
      SUM(CASE WHEN qtd < 0 AND tipo <> 'ajuste' AND data >= ? THEN -qtd ELSE 0 END) AS saidas,
      SUM(CASE WHEN qtd > 0 AND tipo IN ('entrada','compra') THEN qtd ELSE 0 END) AS ent_qtd,
      SUM(CASE WHEN qtd > 0 AND tipo IN ('entrada','compra') THEN qtd * COALESCE(valor_unit, 0) ELSE 0 END) AS ent_valor,
      MAX(CASE WHEN qtd < 0 AND tipo <> 'ajuste' THEN data END) AS ultima_saida
    FROM estoque_mov WHERE desfeito=0 GROUP BY numero`).all(de);
}
const estoqueSomaPorRef = (prefixo) => new Map(db.prepare(`SELECT ref || '|' || numero AS k, SUM(qtd) s FROM estoque_mov
  WHERE historico=0 AND desfeito=0 AND ref LIKE ? GROUP BY ref, numero`).all(prefixo + '%').map((r) => [r.k, r.s]));
function estoqueMovListar({ numero, de, ate, tipo, origem, historico, limite = 500 } = {}) {
  const w = [], p = [];
  if (numero != null) { w.push('numero=?'); p.push(numero); }
  if (de) { w.push('data>=?'); p.push(de); }
  if (ate) { w.push('data<=?'); p.push(ate); }
  if (tipo) { w.push('tipo=?'); p.push(tipo); }
  if (origem) { w.push('origem=?'); p.push(origem); }
  if (historico != null) { w.push('historico=?'); p.push(historico ? 1 : 0); }
  return db.prepare(`SELECT * FROM estoque_mov ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY data DESC, id DESC LIMIT ?`).all(...p, limite);
}
const estoqueMovObter = (id) => db.prepare('SELECT * FROM estoque_mov WHERE id=?').get(id);
// Desfazer um lançamento manual: todas as linhas dele (um kit vira várias), gravadas juntas.
const estoqueMovDesfeito = (m) => db.prepare(`UPDATE estoque_mov SET desfeito=1 WHERE historico=0 AND criado_em=? AND tipo=? AND ref IS ? AND origem IS ? AND quem IS ?`)
  .run(m.criado_em, m.tipo, m.ref, m.origem, m.quem).changes;
// Relatório: soma por período e origem (dia, semana, mês ou ano), entre duas datas.
function estoqueRelatorio(de, ate) {
  return db.prepare(`SELECT data, tipo, origem, numero, qtd, valor_unit FROM estoque_mov WHERE data >= ? AND data <= ? AND desfeito=0`).all(de, ate);
}

const contagemListar = () => db.prepare('SELECT * FROM estoque_contagem').all();
function contagemGravar(numero, contado, quem) {
  if (contado == null) return db.prepare('DELETE FROM estoque_contagem WHERE numero=?').run(numero);
  db.prepare(`INSERT INTO estoque_contagem (numero, contado, quem, em) VALUES (?,?,?,?)
    ON CONFLICT(numero) DO UPDATE SET contado=excluded.contado, quem=excluded.quem, em=excluded.em`).run(numero, contado, quem ?? null, agora());
}
const contagemApagar = (numeros) => { const st = db.prepare('DELETE FROM estoque_contagem WHERE numero=?'); for (const n of numeros) st.run(n); };

const comprasListar = () => db.prepare('SELECT * FROM compras ORDER BY data DESC, pedido DESC, id').all();
const compraObter = (id) => db.prepare('SELECT * FROM compras WHERE id=?').get(id);
function comprasCriar(linhas) {
  const st = db.prepare(`INSERT INTO compras (pedido, data, fornecedor, numero, qtd, previsao, status, recebido_qtd, valor_pago, recebido_em, obs, da_planilha, criado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const em = agora();
  db.exec('BEGIN');
  try {
    for (const l of linhas) st.run(l.pedido, l.data, l.fornecedor ?? null, l.numero, l.qtd, l.previsao ?? null, l.status || 'aberto',
      l.recebido_qtd || 0, l.valor_pago ?? null, l.recebido_em ?? null, l.obs ?? null, l.da_planilha ? 1 : 0, em);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const comprasDaPlanilhaApagar = () => db.prepare('DELETE FROM compras WHERE da_planilha=1').run();
function compraAtualizar(id, c) {
  db.prepare('UPDATE compras SET status=?, recebido_qtd=?, valor_pago=?, recebido_em=? WHERE id=?')
    .run(c.status, c.recebido_qtd, c.valor_pago ?? null, c.recebido_em ?? null, id);
}

// Comanda manual (venda fora dos marketplaces): fica na tela até ser concluída.
const comandasManuaisAbertas = () => db.prepare(`SELECT chave FROM comandas WHERE chave LIKE 'manual:%' AND concluida_em IS NULL`).all().map((r) => r.chave);
const comandaConcluir = (chave, sim = true) => db.prepare('UPDATE comandas SET concluida_em=? WHERE chave=?').run(sim ? agora() : null, chave);
const comandaApagar = (chave) => db.prepare('DELETE FROM comandas WHERE chave=?').run(chave);
// Histórico: as impressas entre duas datas (ISO) ou as de um número de venda (pedido, pack ou um dos pedidos do envio).
const comandaDe = (r) => ({ chave: r.chave, categoria: r.categoria, dia: r.dia, numero: r.numero, criada_em: r.criada_em,
  impressa_em: r.impressa_em, impressoes: r.impressoes, concluida_em: r.concluida_em ?? null, ...JSON.parse(r.dados) });
const comandasImpressasEntre = (de, ate) => db.prepare('SELECT * FROM comandas WHERE impressa_em >= ? AND impressa_em < ? ORDER BY impressa_em DESC LIMIT 2000')
  .all(de, ate).map(comandaDe);
const comandasDoPedido = (num) => db.prepare(`SELECT * FROM comandas WHERE json_extract(dados, '$.pedido') LIKE ?
    OR EXISTS (SELECT 1 FROM json_each(comandas.dados, '$.pedidos') WHERE value LIKE ?) ORDER BY criada_em DESC LIMIT 200`)
  .all(`%${num}%`, `%${num}%`).map(comandaDe);

module.exports = {
  db, DB_FILE, cifrar, decifrar,
  configLer, configGravar,
  senhaDefinir, senhaDefinida, senhaConfere, sessaoCriar, sessaoValida, sessaoEncerrar, sessaoDe,
  usuariosListar, usuarioObter, usuarioPorLogin, usuarioCriar, usuarioAtualizar, usuarioSenhaDefinir, usuarioSenhaConfere,
  usuarioMfa, usuarioMfaGravar, usuarioAcessou, usuarioRemover, usuarioSessoesApagar, auditoriaGravar, auditoriaListar,
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
  devolucaoGravar, devolucaoPackGravar, devolucaoAtualizadaEm, devolucoesListar, vendasUnidadesPorItem,
  custoAutoGravar, embalagemGravar, catalogoGravar, catalogoListar, catalogoResumo,
  vendasLinhas, vendasSemSku, enviosSemFreteConta, ultimasVendas, vendasDesde,
  avisoCriar, avisosListar, avisosNaoLidos, avisosMarcarLidos, defeitoGravar, defeitosDe, defeitoProdutosDe, creditoManualGravar, creditosManuais,
  skusDosPedidos, extraGravar, pedidosSemNome, compradorNomeGravar, compradoresDosPedidos, compradorGravarPedido, logisticaGravar, enviosSemLogistica, vendasComLogistica,
  adsCampanhasVistas, adsCampanhaGravar, adsMudancaGravar, adsMudancas, adsHistoricoDesde,
  atacadoGravar, atacadoDaConta, atacadoEsquecer,
  shopeeLojaSalvar, shopeeTokensGravar, shopeeLojaNomear, shopeeLojaObter, shopeeLojasListar, shopeeLojaRemover,
  shopeePedidosGravar, shopeeSemDetalhe, shopeeDetalheGravar, shopeeSemEscrow, shopeeEscrowGravar, shopeeVendasPeriodo, shopeePendentes,
  shopeeAnunciosGravar, shopeeAnunciosLimparAntes, shopeeAnuncios, shopeePrecoGravar,
  amazonLancGravar, amazonLancPeriodo, amazonLancApagar, amazonFotoGravar, amazonFotos,
  amazonPedidosGravar, amazonPedidosSemItens, amazonItensGravar, amazonVendasPeriodo, amazonUltimoPrecoPorSku, amazonItensSemFoto, amazonUnidadesPorSku,
  amazonConcGravar, amazonConcorrencia, amazonVendedorNomear, amazonVendedoresNomes,
  mpPagamentosGravar, mpPagamentos, mpPagamentosConta, mpExtratoImportar, mpExtrato, mpExtratoSaldos, mpConferencias, mpConferenciaGravar,
  mpVendasDesde, mpVendasDosPedidos, mpPedidosDosEnvios, flexDosEnvios, bonusFlexDosEnvios, bonusFlexMedias,
  concMedidasGravar, concMedidas, concMarcar, concAtualizar, concDesmarcar, concDoItem, concItensMarcados, concResumo,
  qualidadeGravar, qualidadeDe,
  leroyPedidosGravar, leroyPedidosPeriodo, leroyTransacoesGravar, leroyTransacoes, leroyMaisAntigaAberta, leroyCiclosGravar, leroyCiclos, leroyApagarTudo, leroyFreteGravar, leroyFretes, leroyPedidoExiste,
  magaluPedidosGravar, magaluFinanceiroGravar, magaluPedidosPeriodo, magaluFinanceiroDe, magaluApagarTudo,
  magaluAnunciosGravar, magaluAnunciosLimparAntes, magaluPrecoGravar, magaluSemPreco, magaluAnuncios, skuVinculos, skuVinculoGravar,
  comandasDe, comandasDoDia, comandasCriar, comandasAtualizar, comandasListar, comandasImpressas, comandasRenumerar,
  comandasManuaisAbertas, comandaConcluir, comandaApagar, comandasImpressasEntre, comandasDoPedido,
  estoqueProdutos, estoqueProdutoGravar, fornecedoresListar, fornecedorGravar, fornecedorRemover, estoqueMovGravar, estoqueHistoricoTrocar,
  estoqueSaldos, estoqueResumoMov, estoqueSomaPorRef, estoqueMovListar, estoqueMovObter, estoqueMovDesfeito, estoqueRelatorio,
  contagemListar, contagemGravar, contagemApagar, comprasListar, compraObter, comprasCriar, comprasDaPlanilhaApagar, compraAtualizar,
};
