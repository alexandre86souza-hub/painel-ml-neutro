'use strict';
// Bling (ERP das notas fiscais): conexão das DUAS contas do vendedor (pedido do dono, 05/11/2026). Conta 1 = notas da
// Shopee AMG; conta 2 = Amazon, Leroy, Shopee Primor e Magalu (o nome e as lojas de cada uma são digitados na tela).
// Objetivo: emitir pelo painel a nota do pedido que a integração do Bling importou, com o nome CURTO do produto,
// SEM código e com o NCM do produto — hoje o vendedor abre nota por nota no Bling para isso. Esta primeira etapa só
// CONECTA e faz o diagnóstico (leitura): o que a API v3 devolve nos pedidos e nas notas da conta real.
//
// API v3 do Bling (developer.bling.com.br; conferir no diagnóstico):
//   - Aplicativo criado pelo vendedor na Central de Extensões (Área do integrador): Client ID e Client Secret, digitados
//     na tela (segredo cifrado). O "Link de redirecionamento" do aplicativo = {url pública}/bling/callback.
//   - Autorização: https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id&state.
//   - Token: POST /oauth/token com Authorization: Basic base64(id:segredo), formulário grant_type=authorization_code&code
//     (ou refresh_token). Access token ~6 h; o refresh MUDA a cada renovação: grava o novo na hora.
//   - Limite: 3 requisições por segundo por conta.
// Nota fiscal tem dado do comprador (nome, CPF, endereço): o diagnóstico mostra só a FORMA das respostas e, dos itens,
// só o que é do produto (descrição, código, NCM). Nada do Bling no MCP (test-bling.js reprova).
const { forma } = require('./amazon.js');

const API = 'https://api.bling.com.br/Api/v3';
const TOKEN = [`${API}/oauth/token`, 'https://www.bling.com.br/Api/v3/oauth/token'];
const AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const CONTAS = ['1', '2'];
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const chave = (n, k) => `bling_${n}_${k}`;

function contaValida(n) {
  const c = String(n ?? '');
  if (!CONTAS.includes(c)) throw erro('Conta do Bling inválida (1 ou 2).');
  return c;
}

// Credenciais e nome digitados na tela. Segredo vazio = mantém o gravado. Função pura: testada.
function validarConfig(b) {
  const id = String(b?.client_id ?? '').trim();
  if (!/^[0-9a-z]{16,128}$/i.test(id)) throw erro('Client ID: copie o "Client Id" do aplicativo no Bling (letras e números, sem espaços).');
  const out = { client_id: id, nome: String(b?.nome ?? '').trim().slice(0, 60) || null, lojas: String(b?.lojas ?? '').trim().slice(0, 200) || null };
  const seg = String(b?.client_secret ?? '').trim();
  if (seg) {
    if (!/^[0-9a-z]{16,200}$/i.test(seg)) throw erro('Client Secret: copie o "Client Secret" inteiro do aplicativo no Bling.');
    out.client_secret = seg;
  }
  return out;
}

// Endereço da autorização. Função pura: testada.
const urlAutorizacao = ({ clientId, state }) => `${AUTORIZAR}?${new URLSearchParams({ response_type: 'code', client_id: clientId, state })}`;

// Itens de pedido/nota -> só o que é do produto (sem nada do comprador). Função pura: testada.
const itensDoProduto = (itens) => (itens || []).map((i) => ({
  codigo: i.codigo ?? null, descricao: i.descricao ?? null, ncm: i.classificacaoFiscal ?? i.ncm ?? null,
  unidade: i.unidade ?? null, quantidade: i.quantidade ?? null, produto_vinculado: !!(i.produto?.id && Number(i.produto.id) > 0) }));

// ---------- Correção da nota pendente (etapa 2, pedido do dono 05/11/2026) ----------
// A nota que o Bling gera do pedido (situação 1 = Pendente) vem com o título longo do anúncio, o SKU no código e o NCM
// vazio (medido na nota da Amazon). O vendedor troca o nome pelo curto, apaga o código, põe o NCM e a origem do ICMS.
// Origem: produto importado = 1 (importação direta) na conta 1 (AMG, que importa) e 2 (adquirida no mercado interno) na
// conta 2 (Primor, que compra da AMG); bucha e desempenadeira são nacionais = 0. O nome, o NCM e se é nacional ficam
// guardados por SKU (estado bling_itens) a cada correção e voltam como sugestão na próxima nota do mesmo SKU.
// A emissão (envio à Sefaz) continua no Bling, depois da conferência do vendedor.
const NCM_PADRAO = '8481.80.19';
const SITUACAO_NF = { 1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando recibo', 4: 'Rejeitada', 5: 'Autorizada', 6: 'Emitida DANFE', 7: 'Registrada',
  8: 'Aguardando protocolo', 9: 'Denegada', 10: 'Consulta situação', 11: 'Bloqueada' };
const nacionalPeloNome = (d) => /\b(bucha|desempenadeira)/i.test(String(d || ''));
const origemDoProduto = (conta, nacional) => (nacional ? 0 : conta === '1' ? 1 : 2);
const origemDoItem = (it) => it?.origem ?? it?.impostos?.icms?.origem ?? null;
function ncmValido(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length !== 8) throw erro(`NCM "${s ?? ''}" inválido: são 8 números (ex.: 8481.80.19).`);
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
}
// CEST (obrigatório com substituição tributária, ex.: CFOP 5405): 7 números -> "10.079.00"; vazio = sem CEST.
// Sugestão pelo NCM: 8481.80.19 -> 10.079.00 (informado pelo dono, 06/11/2026). Funções puras: testadas.
const CEST_DO_NCM = { '8481.80.19': '10.079.00', '3926.90.90': '10.020.00', '3925.90.90': '10.020.00' };
// NCM pelo nome do produto (informado pelo dono, 06/11/2026); o resto = NCM_PADRAO
const NCM_DO_NOME = [[/desempenadeira/i, '3926.90.90'], [/bucha/i, '3925.90.90']];
const ncmPeloNome = (d) => (NCM_DO_NOME.find(([re]) => re.test(String(d || ''))) || [])[1] || null;
function cestValido(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length !== 7) throw erro(`CEST "${s}" inválido: são 7 números (ex.: 10.079.00).`);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
}
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
function descricaoValida(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 120) throw erro('Nome do produto na nota: de 3 a 120 caracteres.');
  return t;
}
// Sugestão para um item da nota pendente: o que foi salvo para o SKU; senão o nome que veio, o NCM padrão e a origem
// pelo nome. Função pura: testada.
function sugestaoDe(item, salvo) {
  if (salvo) return { descricao: salvo.descricao, ncm: salvo.ncm, cest: salvo.cest ?? item?.cest ?? CEST_DO_NCM[salvo.ncm] ?? '', nacional: !!salvo.nacional, salvo: true };
  const ncm = item?.classificacaoFiscal || ncmPeloNome(item?.descricao) || NCM_PADRAO;
  return { descricao: String(item?.descricao || '').trim(), ncm, cest: item?.cest || CEST_DO_NCM[ncm] || '', nacional: nacionalPeloNome(item?.descricao), salvo: false };
}
// Código "sem código": a API recusa o código vazio ("Codigo do produto … deve ser informado"), e o Bling, quando o
// vendedor apaga o código na tela, põe no XML (cProd) "CFOP" + o CFOP do item (medido 06/11/2026 em 3 notas emitidas:
// CFOP6108, CFOP5405). O painel manda o mesmo. Função pura: testada.
const semCodigo = (c) => !c || /^CFOP\d{4}$/.test(String(c));
function codigoNeutro(it) {
  const cfop = String(it?.cfop ?? '').replace(/\D/g, '');
  if (cfop.length !== 4) throw erro(`O item "${it?.descricao || ''}" está sem CFOP na nota: confira a natureza de operação no Bling.`);
  return `CFOP${cfop}`;
}

// Corpo do PUT /nfe/{id}: a nota lida INTEIRA (o PUT do Bling usa o mesmo esquema do POST) e, nos itens mudados, código
// vazio, nome, NCM e a origem (no item e no ICMS). mudancas = [{ i, descricao, ncm, nacional }]. Função pura: testada.
function corpoCorrigido(nota, conta, mudancas) {
  const b = JSON.parse(JSON.stringify(nota));
  delete b.id;
  // O GET da nota não traz o desconto (nem outras despesas), só o valorNota: devolvido sem ele, o Bling soma os itens e recusa
  // "Total das parcelas difere do total da nota" (medido 06/11/2026: item 28,81, nota e parcelas 26,80 = cupom de 2,01).
  // A diferença entre itens + frete e o valor da nota volta como desconto (ou despesas, se for para mais).
  // O frete o GET dá em valorFrete, mas a gravação lê transporte.frete (POST/PUT): sem ele o Bling zera o frete e a nota
  // fica menor que as parcelas (medido 09/11/2026: itens 550,32 + frete 8 − desconto 48,62 = 509,70; sem o frete, 501,70).
  if (Number(nota.valorFrete) > 0 && b.transporte?.frete == null) b.transporte = { ...(b.transporte || {}), frete: Number(nota.valorFrete) };
  if (b.desconto == null && b.despesas == null && nota.valorNota != null) {
    const itens = (nota.itens || []).reduce((t, i) => t + (Number(i.valorTotal) || Number(i.valor) * Number(i.quantidade) || 0), 0);
    const dif = Math.round((itens + (Number(nota.valorFrete) || 0) - Number(nota.valorNota)) * 100) / 100;
    if (dif > 0) b.desconto = dif;
    else if (dif < 0) b.despesas = -dif;
  }
  b.itens = (nota.itens || []).map((it, i) => {
    const m = mudancas.find((x) => x.i === i);
    if (!m) return it;
    const o = origemDoProduto(conta, m.nacional);
    return { ...it, codigo: codigoNeutro(it), descricao: m.descricao, classificacaoFiscal: m.ncm, cest: m.cest, origem: o,
      impostos: { ...(it.impostos || {}), icms: { ...(it.impostos?.icms || {}), origem: o } } };
  });
  return b;
}

// A nota já está como o vendedor quer? Todo item sem código, com NCM e com a origem sugerida. Função pura: testada.
const itemAjustado = (itens) => itens.length > 0 && itens.every((i) => semCodigo(i.codigo) && !!i.ncm && soDigitos(i.cest) === soDigitos(i.sugestao.cest) && Number(i.origem) === i.sugestao.origem);

// Conta quantos de cada valor. Função pura.
const contar = (lista, f) => lista.reduce((m, x) => { const k = String(f(x) ?? '—'); m[k] = (m[k] || 0) + 1; return m; }, {});

// Loja da Shopee de cada conta do Bling (conta 1 = Shopee AMG, conta 2 = Shopee Primor).
const SHOPEE_DA_CONTA = { 1: '445620092', 2: '717079477' };
const PEDIDO_SHOPEE = /^\d{6}(?=[0-9A-Z]*[A-Z])[0-9A-Z]{6,10}$/;
const ehShopee = (lojaNome, pedidoLoja) => (lojaNome ? /shopee/i.test(lojaNome) : PEDIDO_SHOPEE.test(String(pedidoLoja || '').trim()));

function criar({ D, urlPublica, novoEstadoOAuth, consumirEstadoOAuth, shopee, portaPainel, enviarHtml, redirecionar, pagina, esc }) {
  const config = (n) => ({
    client_id: D.configLer(chave(n, 'client_id')) || null,
    client_secret: D.configLer(chave(n, 'client_secret')) || null,
    refresh_token: D.configLer(chave(n, 'refresh_token')) || null,
    nome: D.configLer(chave(n, 'nome')) || null,
    lojas: D.configLer(chave(n, 'lojas')) || null,
    conectada_em: D.configLer(chave(n, 'conectada_em')) || null,
  });
  const retorno = () => { const base = urlPublica(); return base ? `${new URL(base).origin}/bling/callback` : null; };

  async function pedirToken(n, corpo) {
    const c = config(n);
    const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
    let ultimo = null;
    for (const url of TOKEN) {
      let r;
      try {
        r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000), body: new URLSearchParams(corpo),
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '1.0' } });
      } catch (e) { ultimo = erro(`O Bling não respondeu (${e.message}).`, 502); continue; }
      if (r.status === 404) { ultimo = erro('O Bling não achou o endereço do token.', 502); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.access_token) throw erro(`O Bling recusou: ${j?.error?.description || j?.error?.message || j?.error_description || j?.error || `HTTP ${r.status}`}.`, 401);
      return j;
    }
    throw ultimo;
  }

  const acesso = {}, pedindo = {};
  // o refresh do Bling é de uso único: grava o novo antes de qualquer outra coisa
  const guardar = (n, j) => {
    if (j.refresh_token) D.configGravar(chave(n, 'refresh_token'), j.refresh_token);
    acesso[n] = { token: j.access_token, expira: Date.now() + (Number(j.expires_in) || 21600) * 1000 };
    return acesso[n].token;
  };
  async function token(n) {
    if (acesso[n] && Date.now() < acesso[n].expira - 120e3) return acesso[n].token;
    if (!pedindo[n]) {
      const c = config(n);
      if (!c.client_id || !c.client_secret || !c.refresh_token) throw erro(`Conecte a conta ${n} do Bling primeiro.`, 409);
      pedindo[n] = pedirToken(n, { grant_type: 'refresh_token', refresh_token: c.refresh_token })
        .then((j) => guardar(n, j)).finally(() => { pedindo[n] = null; });
    }
    return pedindo[n];
  }

  // Fila por conta: no máximo 3 por segundo (limite do Bling).
  const ultimas = {};
  async function vez(n) {
    const agora = Date.now(), l = (ultimas[n] || []).filter((t) => agora - t < 1000);
    if (l.length >= 3) await new Promise((ok) => setTimeout(ok, 1000 - (agora - l[0]) + 20));
    ultimas[n] = [...l, Date.now()].slice(-3);
  }

  // Uma chamada à API v3 da conta n. Escrita só por quem a chamar com metodo != GET (nesta etapa, ninguém).
  async function bling(n, caminho, { metodo = 'GET', corpo = null } = {}) {
    for (let tentativa = 0; ; tentativa++) {
      await vez(n);
      let r;
      try {
        r = await fetch(API + caminho, { method: metodo, signal: AbortSignal.timeout(30000), body: corpo ? JSON.stringify(corpo) : undefined,
          headers: { Authorization: `Bearer ${await token(n)}`, Accept: 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) } });
      } catch (e) { if (e.status) throw e; throw erro(`O Bling não respondeu (${e.message}).`, 502); }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1))); continue; }
      if (r.status === 401) acesso[n] = null;
      if (r.status === 204) return null;
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const e = j?.error || {};
        const campos = (e.fields || []).map((f) => f.msg || f.element).filter(Boolean).join('; ');
        throw erro(`Bling: ${e.description || e.message || `HTTP ${r.status}`}${campos ? ` (${campos})` : ''}`, r.status >= 500 ? 502 : r.status);
      }
      return j;
    }
  }

  const origemDe = (url) => {
    if (url?.origin === 'https://painel') return new URL(urlPublica()).origin;
    if (url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return url.origin;
    return `http://localhost:${portaPainel()}`;
  };
  const publica = (n) => { const c = config(n); return { conta: n, client_id: c.client_id, tem_segredo: !!c.client_secret, conectada: !!c.refresh_token,
    nome: c.nome, lojas: c.lojas, conectada_em: c.conectada_em }; };

  // nome curto, NCM e nacional por SKU (o código que veio na nota pendente), guardados a cada correção
  const salvos = () => { try { return JSON.parse(D.configLer('bling_itens') || '{}') || {}; } catch { return {}; } };
  const itemDaNota = (n, it, i, s) => ({ i, codigo: it.codigo || '', descricao: it.descricao || '', ncm: it.classificacaoFiscal || '', cest: it.cest || '',
    origem: origemDoItem(it), quantidade: it.quantidade ?? null, valor: it.valorTotal ?? null,
    sugestao: (() => { const g = sugestaoDe(it, it.codigo ? s[it.codigo] : null); return { ...g, origem: origemDoProduto(n, g.nacional) }; })() });
  // só o que a tela precisa: nada do destinatário (contato, endereço, etiqueta)
  const notaDaTela = (n, x, s) => {
    const itens = (x.itens || []).map((it, i) => itemDaNota(n, it, i, s));
    return { id: x.id, numero: x.numero ?? null, cliente: x.contato?.nome || null, serie: x.serie ?? null, situacao: x.situacao ?? null,
      data: x.dataEmissao ?? null, loja: x.loja?.id ?? null, pedido_loja: x.numeroPedidoLoja ?? null, valor: x.valorNota ?? null,
      totais: { frete: x.valorFrete ?? null, itens: (x.itens || []).reduce((t, i) => t + (Number(i.valorTotal) || Number(i.valor) * Number(i.quantidade) || 0), 0),
        parcelas: (x.parcelas || []).reduce((t, p) => t + (Number(p.valor) || 0), 0), chaves: Object.keys(x).filter((k) => /valor|desconto|despesa|seguro|frete|outr/i.test(k)), transporte: Object.keys(x.transporte || {}) },
      itens, ajustada: itemAjustado(itens) };
  };

  // Ajusta os itens de uma nota PENDENTE (lida inteira) e confere relendo. mudancas brutas da tela: [{ i, descricao, ncm, cest, nacional }].
  async function ajustarNota(n, nota, brutas) {
    const id = nota.id;
    if (Number(nota.situacao) !== 1) throw erro('Essa nota não está mais pendente no Bling (já foi enviada ou emitida): nada foi mudado.', 409);
    const itens = nota.itens || [];
    const mudancas = (Array.isArray(brutas) ? brutas : []).map((m) => {
      const i = Number(m?.i);
      if (!Number.isInteger(i) || i < 0 || i >= itens.length) throw erro('Item da nota inválido.');
      return { i, descricao: descricaoValida(m.descricao), ncm: ncmValido(m.ncm), cest: cestValido(m.cest), nacional: !!m.nacional };
    });
    if (!mudancas.length) throw erro('Nenhum item para corrigir.');
    await bling(n, `/nfe/${id}`, { metodo: 'PUT', corpo: corpoCorrigido(nota, n, mudancas) });
    // guarda por SKU (o código que veio no item) para a próxima nota
    const s = salvos();
    for (const m of mudancas) {
      const sku = itens[m.i].codigo;
      if (sku && !semCodigo(sku)) s[sku] = { descricao: m.descricao, ncm: m.ncm, cest: m.cest, nacional: m.nacional, em: new Date().toISOString() };
    }
    D.configGravar('bling_itens', JSON.stringify(s));
    // relê para conferir o que o Bling gravou. Logo depois do PUT o GET às vezes ainda devolve a nota antiga (medido 09/11/2026:
    // 6 notas "não bateram" e estavam certas um minuto depois): relê até 3 vezes, com 2 s e 4 s de espera, antes de dizer que não bateu.
    const conferir = (depois) => mudancas.map((m) => {
      const it = (depois.itens || [])[m.i] || {};
      const o = origemDoProduto(n, m.nacional);
      const ok = { nome: String(it.descricao || '').trim() === m.descricao, codigo: semCodigo(it.codigo), ncm: (it.classificacaoFiscal || '') === m.ncm, cest: soDigitos(it.cest) === soDigitos(m.cest), origem: Number(origemDoItem(it)) === o };
      return { i: m.i, ...ok, tudo: Object.values(ok).every(Boolean) };
    });
    let depois = {}, conferencia = [];
    for (let k = 0; k < 3; k++) {
      if (k) await new Promise((ok) => setTimeout(ok, 2000 * k));
      depois = (await bling(n, `/nfe/${id}`)).data || {};
      conferencia = conferir(depois);
      if (conferencia.every((c) => c.tudo)) break;
    }
    return { nota: { ...notaDaTela(n, depois, salvos()), loja_nome: (await lojasDe(n))[depois.loja?.id] || null }, conferencia, tudo_certo: conferencia.every((c) => c.tudo) };
  }

  // nome de cada loja (canal de venda) do Bling, por id; 1 h em memória
  const canais = {};
  async function lojasDe(n) {
    if (canais[n] && Date.now() - canais[n].em < 3600e3) return canais[n].m;
    const m = {};
    try { for (const c of (await bling(n, '/canais-venda?pagina=1&limite=100')).data || []) m[c.id] = c.descricao || c.nome || null; } catch { /* sem nome: a tela usa o formato do pedido */ }
    canais[n] = { em: Date.now(), m };
    return m;
  }

  // Manda o XML da nota AUTORIZADA ao pedido da Shopee (v2.order.upload_invoice_doc, file_type 4 = XML). O Bling não tem
  // envio automático para a Shopee. O XML (tem dado do comprador) só passa pela memória: não é guardado.
  async function enviarNotaShopee(n, nota) {
    const lojaNome = (await lojasDe(n))[nota.loja?.id] || null;
    if (!ehShopee(lojaNome, nota.numeroPedidoLoja)) return { aplica: false };
    const shop = SHOPEE_DA_CONTA[n];
    const pedido = String(nota.numeroPedidoLoja || '').trim();
    if (!shop || !shopee) return { aplica: true, enviada: false, motivo: 'Loja da Shopee desta conta não configurada no painel.' };
    if (!pedido) return { aplica: true, enviada: false, motivo: 'A nota não tem o número do pedido da Shopee.' };
    if (![5, 6, 7].includes(Number(nota.situacao))) return { aplica: true, enviada: false, motivo: 'A nota ainda não está autorizada.' };
    if (!/^https:\/\//.test(nota.xml || '')) return { aplica: true, enviada: false, motivo: 'O Bling não deu o link do XML da nota.' };
    try {
      const r = await fetch(nota.xml, { signal: AbortSignal.timeout(20000) });
      const xml = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !/<(nfeProc|NFe)\b/.test(xml.subarray(0, 4000).toString('utf8'))) throw erro('O link do XML do Bling não devolveu o XML da nota.', 502);
      if (xml.length > 1024 * 1024) throw erro('O XML passa de 1 MB (limite da Shopee).', 400);
      const fd = new FormData();
      fd.append('order_sn', pedido);
      fd.append('file_type', '4');
      fd.append('file', new Blob([xml], { type: 'text/xml' }), `${nota.chaveAcesso || nota.numero || 'nota'}.xml`);
      await shopee(shop, '/api/v2/order/upload_invoice_doc', {}, fd);
      const env = enviadasShopee();
      env[nota.id] = { pedido, em: new Date().toISOString() };
      const ids = Object.keys(env);
      for (const k of ids.slice(0, Math.max(0, ids.length - 500))) delete env[k];   // só as 500 mais novas
      D.configGravar('bling_shopee_enviadas', JSON.stringify(env));
      return { aplica: true, enviada: true, pedido };
    } catch (e) { return { aplica: true, enviada: false, pedido, motivo: e.message }; }
  }

  const enviadasShopee = () => { try { return JSON.parse(D.configLer('bling_shopee_enviadas') || '{}') || {}; } catch { return {}; } };

  // notas autorizadas dos últimos dias (lista da tela "emitidas"); o detalhe de cada uma é lido (3/s), então fica 5 min em memória
  const emitidasCache = {};
  async function emitidas(n, dias) {
    const c = emitidasCache[`${n}:${dias}`];
    if (c && Date.now() - c.em < 5 * 60e3) return c.notas;
    const desde = new Date(Date.now() - (dias - 1) * 864e5 - 3 * 3600e3).toISOString().slice(0, 10);   // dia em Brasília
    const lista = [];
    for (const sit of [5, 6]) lista.push(...((await bling(n, `/nfe?pagina=1&limite=100&tipo=1&situacao=${sit}&dataEmissaoInicial=${desde}`)).data || []));
    lista.sort((a, b) => String(b.dataEmissao || '').localeCompare(String(a.dataEmissao || '')));
    const lojas = await lojasDe(n), env = enviadasShopee(), notas = [];
    for (const x of lista.slice(0, 40)) {
      const d = (await bling(n, `/nfe/${x.id}`)).data || x;
      const lojaNome = lojas[d.loja?.id] || null;
      notas.push({ id: d.id, numero: d.numero ?? null, data: d.dataEmissao ?? null, cliente: d.contato?.nome || null, loja_nome: lojaNome,
        pedido_loja: d.numeroPedidoLoja ?? null, valor: d.valorNota ?? null, situacao: Number(d.situacao), situacao_nome: SITUACAO_NF[d.situacao] || String(d.situacao),
        shopee: ehShopee(lojaNome, d.numeroPedidoLoja), shopee_enviada: env[d.id] || null });
    }
    emitidasCache[`${n}:${dias}`] = { em: Date.now(), notas };
    return notas;
  }

  const rotas = {
    // Notas AUTORIZADAS dos últimos dias (1–7), com o envio à Shopee feito pelo painel. Só leitura.
    'GET /api/bling/emitidas': async (url) => {
      const n = contaValida(url.searchParams.get('conta'));
      const dias = Math.min(7, Math.max(1, Number(url.searchParams.get('dias')) || 3));
      if (url.searchParams.get('recarregar')) delete emitidasCache[`${n}:${dias}`];
      return { conta: publica(n), dias, notas: await emitidas(n, dias) };
    },
    // { conta, id } — (re)envia à Shopee o XML de uma nota já AUTORIZADA (clique na tela).
    'POST /api/bling/notas/enviar-shopee': async (_u, body) => {
      const n = contaValida(body?.conta);
      const id = String(body?.id ?? '');
      if (!/^\d{1,20}$/.test(id)) throw erro('Nota inválida.');
      const nota = (await bling(n, `/nfe/${id}`)).data;
      if (!nota) throw erro('O Bling não achou essa nota.', 404);
      const r = await enviarNotaShopee(n, nota);
      if (!r.aplica) throw erro('Essa nota não é de pedido da Shopee.', 409);
      return r;
    },
    // Notas de saída PENDENTES (ainda não emitidas) da conta, com a sugestão de cada item.
    'GET /api/bling/notas': async (url) => {
      const n = contaValida(url.searchParams.get('conta'));
      // 1 = Pendente (falta ajustar e/ou emitir); 4 = Rejeitada pela Sefaz (corrigir no Bling)
      const lista = [...((await bling(n, '/nfe?pagina=1&limite=50&tipo=1&situacao=1')).data || []),
        ...((await bling(n, '/nfe?pagina=1&limite=20&tipo=1&situacao=4')).data || [])];
      const s = salvos(), notas = [], lojas = await lojasDe(n);
      for (const x of lista.slice(0, 30)) {
        const d = (await bling(n, `/nfe/${x.id}`)).data;
        if (d && [1, 4].includes(Number(d.situacao))) notas.push({ ...notaDaTela(n, d, s), loja_nome: lojas[d.loja?.id] || null });
      }
      return { conta: publica(n), notas, mais: lista.length > 30 };
    },
    // { conta, id, itens: [{ i, descricao, ncm, nacional }] } — corrige os itens da nota PENDENTE no Bling (não emite).
    // { conta, id } — EMITE a nota (envia à Sefaz pelo Bling). Escrita fiscal: só pelo clique, com confirmação na tela, e só
    // nota PENDENTE já ajustada (sem SKU no código, com NCM, CEST e origem). Espera a resposta da Sefaz por até ~25 s.
    'POST /api/bling/notas/emitir': async (_u, body) => {
      const n = contaValida(body?.conta);
      const id = String(body?.id ?? '');
      if (!/^\d{1,20}$/.test(id)) throw erro('Nota inválida.');
      const nota = (await bling(n, `/nfe/${id}`)).data;
      if (!nota) throw erro('O Bling não achou essa nota.', 404);
      if (Number(nota.situacao) !== 1) throw erro(`Essa nota não está pendente no Bling (situação: ${SITUACAO_NF[nota.situacao] || nota.situacao}): nada foi enviado.`, 409);
      const tela = notaDaTela(n, nota, salvos());
      if (!tela.ajustada) throw erro('Ajuste os itens antes de emitir (código, NCM, CEST e origem).', 409);
      await bling(n, `/nfe/${id}/enviar?enviarEmail=false`, { metodo: 'POST' });
      let d = nota;
      for (let k = 0; k < 8; k++) {
        await new Promise((ok) => setTimeout(ok, 3000));
        d = (await bling(n, `/nfe/${id}`)).data || d;
        if (![1, 3, 8, 10].includes(Number(d.situacao))) break;
      }
      const sit = Number(d.situacao);
      const autorizada = [5, 6, 7].includes(sit);
      const shopeeEnvio = autorizada ? await enviarNotaShopee(n, d) : null;
      for (const k of Object.keys(emitidasCache)) if (k.startsWith(`${n}:`)) delete emitidasCache[k];
      return { id: d.id, numero: d.numero ?? null, situacao: sit, situacao_nome: SITUACAO_NF[sit] || String(sit),
        autorizada, rejeitada: sit === 4, aguardando: [1, 3, 8, 10].includes(sit), shopee: shopeeEnvio?.aplica ? shopeeEnvio : null };
    },
    'POST /api/bling/notas/corrigir': async (_u, body) => {
      const n = contaValida(body?.conta);
      const id = String(body?.id ?? '');
      if (!/^\d{1,20}$/.test(id)) throw erro('Nota inválida.');
      const nota = (await bling(n, `/nfe/${id}`)).data;
      if (!nota) throw erro('O Bling não achou essa nota.', 404);
      return ajustarNota(n, nota, body?.itens);
    },
    // Pedidos de venda SEM nota (últimos 15 dias), com a sugestão de cada item — para gerar a nota pelo painel.
    'GET /api/bling/pedidos': async (url) => {
      const n = contaValida(url.searchParams.get('conta'));
      const desde = new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10);
      const lista = [];
      for (let p = 1; p <= 3; p++) {
        const d = (await bling(n, `/pedidos/vendas?pagina=${p}&limite=100&dataInicial=${desde}`)).data || [];
        lista.push(...d);
        if (d.length < 100) break;
      }
      // 9 = Atendido (já tem nota), 12 = Cancelado
      const cand = lista.filter((p) => ![9, 12].includes(Number(p.situacao?.id)));
      const s = salvos(), lojas = await lojasDe(n), pedidos = [];
      for (const p of cand.slice(0, 40)) {
        const d = (await bling(n, `/pedidos/vendas/${p.id}`)).data;
        if (!d || d.notaFiscal?.id) continue;
        pedidos.push({ id: d.id, numero: d.numero ?? null, pedido_loja: d.numeroLoja ?? null, cliente: d.contato?.nome || null, data: d.data ?? null, valor: d.total ?? null,
          loja: d.loja?.id ?? null, loja_nome: lojas[d.loja?.id] || null, situacao: d.situacao?.id ?? null,
          itens: (d.itens || []).map((it, i) => { const g = sugestaoDe({ descricao: it.descricao }, it.codigo ? s[it.codigo] : null);
            return { i, codigo: it.codigo || '', descricao: it.descricao || '', quantidade: it.quantidade ?? null, valor: it.valor ?? null,
              sugestao: { ...g, origem: origemDoProduto(n, g.nacional) } }; }) });
      }
      return { conta: publica(n), pedidos, mais: cand.length > 40 };
    },
    // { conta, id, itens: [{ i, descricao, ncm, cest, nacional }] } — GERA a nota do pedido no Bling (pendente, não emite) e já
    // ajusta os itens (i = posição no pedido). Escrita só pelo clique, com confirmação na tela.
    'POST /api/bling/pedidos/gerar': async (_u, body) => {
      const n = contaValida(body?.conta);
      const id = String(body?.id ?? '');
      if (!/^\d{1,20}$/.test(id)) throw erro('Pedido inválido.');
      const ped = (await bling(n, `/pedidos/vendas/${id}`)).data;
      if (!ped) throw erro('O Bling não achou esse pedido.', 404);
      if (ped.notaFiscal?.id) throw erro('Esse pedido já tem nota no Bling: nada foi gerado. Clique em Atualizar.', 409);
      const g = await bling(n, `/pedidos/vendas/${id}/gerar-nfe`, { metodo: 'POST' });
      let idNota = g?.data?.id ?? g?.data?.idNotaFiscal ?? g?.data?.notaFiscal?.id ?? null;
      if (!idNota) idNota = (await bling(n, `/pedidos/vendas/${id}`)).data?.notaFiscal?.id ?? null;
      if (!idNota) throw erro('O Bling gerou, mas não disse qual nota: clique em Atualizar e ajuste na lista de notas.', 502);
      const nota = (await bling(n, `/nfe/${idNota}`)).data;
      if (!nota) throw erro('Nota gerada, mas não consegui ler: clique em Atualizar.', 502);
      // item do pedido -> item da nota pelo código (SKU), senão pela posição
      const itensP = ped.itens || [], itensN = nota.itens || [];
      const mud = (Array.isArray(body?.itens) ? body.itens : []).map((m) => {
        const cod = itensP[Number(m?.i)]?.codigo;
        const k = cod ? itensN.findIndex((x) => x.codigo === cod) : -1;
        return { ...m, i: k >= 0 ? k : Number(m?.i) };
      });
      const r = await ajustarNota(n, nota, mud);
      return { ...r, gerada: true };
    },
    'GET /api/bling/config': async () => ({ retorno: retorno(), contas: CONTAS.map(publica) }),
    // { conta, client_id, client_secret?, nome?, lojas? }
    'PUT /api/bling/config': async (_u, body) => {
      const n = contaValida(body?.conta), c = validarConfig(body);
      D.configGravar(chave(n, 'client_id'), c.client_id);
      D.configGravar(chave(n, 'nome'), c.nome);
      D.configGravar(chave(n, 'lojas'), c.lojas);
      if (c.client_secret) D.configGravar(chave(n, 'client_secret'), c.client_secret);
      if (!D.configLer(chave(n, 'client_secret'))) throw erro('Informe também o Client Secret.');
      acesso[n] = null;
      return publica(n);
    },
    'POST /api/bling/conectar': async (url, body) => {
      const n = contaValida(body?.conta), c = config(n);
      if (!c.client_id || !c.client_secret) throw erro('Salve o Client ID e o Client Secret desta conta primeiro.', 409);
      if (!retorno()) throw erro('O endereço público do painel está fora do ar: o Bling não tem para onde voltar.', 409);
      return { url: urlAutorizacao({ clientId: c.client_id, state: novoEstadoOAuth({ origem: origemDe(url), bling: n }) }) };
    },
    'POST /api/bling/remover': async (_u, body) => {
      const n = contaValida(body?.conta);
      for (const k of ['refresh_token', 'conectada_em']) D.configGravar(chave(n, k), null);
      acesso[n] = null;
      return { removida: true };
    },
    // Diagnóstico (só leitura): pedidos de venda e notas de saída recentes. Mostra a FORMA, as situações e lojas
    // (ids), e dos itens só o que é do produto: descrição, código, NCM e se está ligado a um produto do Bling.
    'GET /api/bling/diagnostico': async (url) => {
      const n = contaValida(url.searchParams.get('conta'));
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const pedidos = await passo(() => bling(n, '/pedidos/vendas?pagina=1&limite=20'));
      const notas = await passo(() => bling(n, '/nfe?pagina=1&limite=20&tipo=1'));
      const listaP = pedidos.data || [], listaN = notas.data || [];
      const detP = [], detN = [];
      for (const p of listaP.slice(0, 5)) { const d = await passo(() => bling(n, `/pedidos/vendas/${p.id}`)); if (d.data) detP.push(d.data); }
      for (const x of listaN.slice(0, 8)) { const d = await passo(() => bling(n, `/nfe/${x.id}`)); if (d.data) detN.push(d.data); }
      const naturezas = await passo(() => bling(n, '/naturezas-operacoes?pagina=1&limite=50'));
      // o que vai no XML (cProd) das notas emitidas com o código vazio no Bling: só os códigos dos itens
      const cprod = [];
      for (const x of detN.filter((d) => /^https:\/\//.test(d.xml || '') && (d.itens || []).some((i) => !i.codigo)).slice(0, 3)) {
        const r = await passo(async () => {
          const t = await (await fetch(x.xml, { signal: AbortSignal.timeout(20000) })).text();
          return { codigos: [...t.matchAll(/<cProd>([^<]*)<\/cProd>/g)].map((m) => m[1]), produtos: [...t.matchAll(/<xProd>([^<]*)<\/xProd>/g)].map((m) => m[1]) };
        });
        cprod.push(r);
      }
      return {
        conta: publica(n),
        pedidos: pedidos.erro ? { erro: pedidos.erro } : { quantidade: listaP.length, situacoes: contar(listaP, (p) => p.situacao?.id), lojas: contar(listaP, (p) => p.loja?.id) },
        notas: notas.erro ? { erro: notas.erro } : { quantidade: listaN.length, situacoes: contar(listaN, (x) => x.situacao), lojas: contar(listaN, (x) => x.loja?.id) },
        // o que interessa para a emissão: o pedido chega sem produto ligado? a nota leva código e NCM?
        itens_pedidos: detP.map((p) => ({ tem_nota: !!(p.notaFiscal?.id), loja: p.loja?.id ?? null, itens: itensDoProduto(p.itens) })),
        itens_notas: detN.map((x) => ({ situacao: x.situacao ?? null, loja: x.loja?.id ?? null, natureza: x.naturezaOperacao?.id ?? null, itens: itensDoProduto(x.itens) })),
        cprod_emitidas: cprod,
        naturezas: naturezas.erro ? { erro: naturezas.erro } : (naturezas.data || []).map((z) => ({ id: z.id, descricao: z.descricao ?? null, situacao: z.situacao ?? null, padrao: z.padrao ?? null })),
        forma: { pedido_lista: listaP[0] ? forma(listaP[0]) : null, pedido: detP[0] ? forma(detP[0]) : null,
          nota_lista: listaN[0] ? forma(listaN[0]) : null, nota: detN[0] ? forma(detN[0]) : null },
      };
    },
  };

  // Retorno da autorização, pelo endereço público. O state de uso único (15 min) diz qual conta e prova que nasceu no painel.
  async function callback(res, url) {
    const st = consumirEstadoOAuth(url.searchParams.get('state') || '');
    const voltar = st?.origem || `http://localhost:${portaPainel()}`;
    const falha = (titulo, detalhe, code = 400) => enviarHtml(res, pagina(titulo, `<h1>${esc(titulo)}</h1>
<pre>${esc(detalhe)}</pre><p><a href="${esc(voltar)}/bling-conexao.html">Voltar ao painel</a></p>`, code));
    if (!st?.bling || !CONTAS.includes(st.bling)) return falha('Autorização expirada ou desconhecida', 'Este retorno não corresponde a um "Conectar" feito pelo painel nos últimos 15 minutos.\nVolte ao painel e clique em "Conectar" de novo.');
    if (url.searchParams.get('error')) return falha('O Bling não autorizou', `${url.searchParams.get('error')}: ${url.searchParams.get('error_description') || ''}`);
    const code = url.searchParams.get('code');
    if (!code) return falha('Retorno sem código', 'O Bling não enviou o código de autorização.');
    const n = st.bling;
    try {
      const j = await pedirToken(n, { grant_type: 'authorization_code', code });
      guardar(n, j);
      D.configGravar(chave(n, 'conectada_em'), new Date().toISOString());
      return redirecionar(res, `${voltar}/bling-conexao.html?conectado=${n}`);
    } catch (e) { return falha('O Bling não entregou o acesso', e.message, 502); }
  }

  return { rotas, rotasParam: [], callback, bling };
}

module.exports = { criar, ehShopee, SHOPEE_DA_CONTA, validarConfig, urlAutorizacao, itensDoProduto, contaValida, CONTAS,
  sugestaoDe, corpoCorrigido, itemAjustado, semCodigo, codigoNeutro, ncmValido, cestValido, descricaoValida, origemDoProduto, nacionalPeloNome };
