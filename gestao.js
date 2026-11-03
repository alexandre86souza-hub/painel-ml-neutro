'use strict';
// Gestão do dinheiro depois da venda (pedido do dono, 03/11/2026), de TODAS as contas e lojas:
//  - Caixa a receber (GET /api/caixa): o que cada loja ainda vai depositar, quando, o que está retido e o que já caiu.
//    ML pelo Mercado Pago (financeiro.js), Leroy pelos ciclos (leroy.js#repassesDe), Amazon pelos grupos financeiros
//    (amazon.js#repasses), Shopee pela situação do pedido + repasse (escrow), Magalu pela análise financeira do pedido.
//  - DRE do mês (GET /api/dre?mes=AAAA-MM): faturamento − tarifas − frete − custo − embalagem − imposto (Simples do CNPJ
//    quando a tela Metas tem o CNPJ) = margem de contribuição; − Ads − devoluções = resultado da loja; − custos fixos
//    (digitados na tela, PUT /api/dre/custos) = resultado do CNPJ.
//  - Placar de promoções e Ads (GET /api/placar?dias=): quanto vendeu com promoção, desconto dado, promoções paradas (ML),
//    gasto do Ads, ROAS, TACOS e o lucro depois do Ads, loja a loja.
// Tudo só leitura das lojas; sem dado de cliente; fora do MCP (tem Amazon).
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const erro = (m, status = 400) => Object.assign(new Error(m), { status });
const diaBR = (t) => new Date(Date.parse(t) - 3 * 3600e3).toISOString().slice(0, 10);

// ---------- caixa ----------
const SHOPEE_FORA = new Set(['CANCELLED', 'IN_CANCEL', 'UNPAID']);
// Shopee: o repasse do pedido cai na carteira quando ele fica COMPLETED (comprador confirmou ou o prazo venceu); antes disso
// é a receber; TO_RETURN = devolução em análise (retido). Valor = escrow_amount; sem repasse lido ainda, a estimativa da loja
// (faturamento × (1 − proporção das taxas) + frete médio que a Shopee repassa). rows = shopeeVendasPeriodo. Função pura: testada.
function caixaShopeeDe(rows, { proporcao = null, frete_medio = {}, precoDe, agora = Date.now() } = {}) {
  const porPedido = new Map();
  for (const r of rows) { const a = porPedido.get(r.order_sn) || []; a.push(r); porPedido.set(r.order_sn, a); }
  const t = { a_receber: 0, retido: 0, liberado_30: 0, qtd_a_receber: 0, qtd_retido: 0, estimados: 0 };
  const desde = agora / 1000 - 30 * 86400;
  for (const itens of porPedido.values()) {
    const p = itens[0];
    if (SHOPEE_FORA.has(p.status)) continue;
    let v = p.recebido;
    if (v == null) {
      if (proporcao == null) continue;
      const fat = itens.reduce((s, i) => s + precoDe(p, i) * n(i.quantidade), 0);
      v = fat * (1 - proporcao) + n(frete_medio[p.transportadora || '']);
      if (p.status !== 'COMPLETED') t.estimados++;
    }
    if (p.status === 'COMPLETED') { if (n(p.atualizado) >= desde) t.liberado_30 += n(v); }
    else if (p.status === 'TO_RETURN') { t.retido += n(v); t.qtd_retido++; }
    else { t.a_receber += n(v); t.qtd_a_receber++; }
  }
  for (const k of ['a_receber', 'retido', 'liberado_30']) t[k] = r2(t[k]);
  return t;
}

// Magalu: o depósito é semanal (segunda-feira) e a análise financeira NÃO diz se o pedido já foi pago — medido 03/11/2026: o
// status "ready" vai de julho até hoje e soma quase todo o vendido; "awaiting_payment" e "PROCESSED" são poucos lançamentos.
// Então: pedido ainda não entregue = a receber (certo); entregue nos últimos 30 dias = pode estar no próximo depósito ou já ter
// caído (à parte). Valor = líquido da análise financeira; sem ela, faturamento − comissão (estimado). Cancelado fica fora.
// Devolve também os status vistos, com datas e valor (para conferir). Função pura: testada.
const magaluConta = (t) => t.status !== 'not_applicable' && !(t.tipo === 'DEBIT' && t.sub === 'ABSOLUTE_DISCOUNT');
function caixaMagaluDe(pedidos, financeiro, agora = Date.now()) {
  const t = { a_receber: 0, entregue_30: 0, qtd_a_receber: 0, qtd_entregue_30: 0, estimados: 0, status: {} };
  const desde = new Date(agora - 30 * 864e5).toISOString();
  for (const p of pedidos) {
    if (/cancel/i.test(p.status || '')) continue;
    const ts = (financeiro.get(p.code) || []).filter(magaluConta);
    for (const x of ts) {
      const s = t.status[x.status || '?'] || (t.status[x.status || '?'] = { n: 0, valor: 0, de: x.data, ate: x.data });
      s.n++; s.valor = r2(s.valor + (x.tipo === 'CREDIT' ? 1 : -1) * n(x.valor));
      if (x.data && (!s.de || x.data < s.de)) s.de = x.data;
      if (x.data && (!s.ate || x.data > s.ate)) s.ate = x.data;
    }
    let v;
    if (ts.length) v = ts.reduce((s, x) => s + (x.tipo === 'CREDIT' ? 1 : -1) * n(x.valor), 0);
    else {
      const fat = (p.itens || []).reduce((s, i) => s + n(i.faturamento), 0);
      if (fat <= 0) continue;
      v = fat - n(p.comissao);
    }
    if (!p.entregue) { t.a_receber += v; t.qtd_a_receber++; if (!ts.length) t.estimados++; }
    else if (p.entregue >= desde) { t.entregue_30 += v; t.qtd_entregue_30++; }
  }
  t.a_receber = r2(t.a_receber); t.entregue_30 = r2(t.entregue_30);
  return t;
}
// Próxima segunda-feira (dia do depósito da Magalu), em Brasília. Hoje sendo segunda, é hoje.
function proximaSegunda(agora = Date.now()) {
  const d = new Date(agora - 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
// Leroy (leroy.js#repassesDe): ciclos já fechados com a data prevista no futuro (ainda não pagos, como na tela da Leroy) + o
// ciclo aberto + o que espera a entrega. Função pura: testada.
function caixaLeroyDe(r, agora = Date.now()) {
  const fechados = (r.ciclos || []).filter((c) => c.previsto && Date.parse(c.previsto) > agora)
    .sort((a, b) => a.previsto.localeCompare(b.previsto));
  const datas = [...fechados.map((c) => ({ data: diaBR(c.previsto), valor: r2(n(c.valor)) })),
    ...(r.proximo?.previsto ? [{ data: diaBR(r.proximo.previsto), valor: r2(n(r.proximo.valor)) }] : [])];
  const desde = new Date(agora - 30 * 864e5).toISOString();
  return { a_receber: r2(datas.reduce((s, d) => s + d.valor, 0) + n(r.aguardando_entrega?.valor)),
    proximos_7: r2(datas.filter((d) => Date.parse(`${d.data}T12:00:00Z`) - agora <= 7 * 864e5).reduce((s, d) => s + d.valor, 0)), retido: 0,
    liberado_30: r2((r.ciclos || []).filter((c) => c.previsto && Date.parse(c.previsto) <= agora && c.previsto >= desde).reduce((s, c) => s + n(c.valor), 0)),
    proximo: datas[0] || null, por_dia_leroy: datas, aguardando_entrega: r.aguardando_entrega?.valor ?? 0 };
}
// Soma das lojas (o que tiver número). Função pura: testada.
function totaisCaixa(lojas) {
  const s = (k) => r2(lojas.reduce((a, l) => a + n(l[k]), 0));
  return { a_receber: s('a_receber'), proximos_7: s('proximos_7'), retido: s('retido'), liberado_30: s('liberado_30') };
}

// ---------- DRE ----------
// Mês AAAA-MM -> início e fim em Brasília. Função pura: testada.
function janelaMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  const de = new Date(Date.UTC(+m[1], +m[2] - 1, 1, 3)).toISOString(), ate = new Date(Date.UTC(+m[1], +m[2], 1, 3)).toISOString();
  return { mes, de, ate };
}
const PARTES = ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto'];
// Vendas de uma loja no mês: soma das partes das vendas válidas (sem custo conta como zero no custo e entra em sem_custo).
// Função pura: testada.
function somaDoMes(linhas, { de, ate }) {
  const s = Object.fromEntries(PARTES.map((k) => [k, 0]));
  let pedidos = new Set(), semCusto = 0, fatSemCusto = 0;
  for (const l of linhas) {
    if (!l.valida || !l.data || l.data < de || l.data >= ate) continue;
    for (const k of PARTES) s[k] += n(l[k]);
    pedidos.add(l.pedido);
    if (l.lucro == null) { semCusto++; fatSemCusto += n(l.faturamento); }
  }
  for (const k of PARTES) s[k] = r2(s[k]);
  return { ...s, pedidos: pedidos.size, sem_custo: semCusto, faturamento_sem_custo: r2(fatSemCusto) };
}
// Custos fixos do mês: os de todo mês (fixos) + os lançados só naquele mês. cnpj '' = da empresa toda (rateado pelo
// faturamento entre os CNPJs). Função pura: testada.
function custosDoMes(cfg, mes) {
  const lista = [...(cfg?.fixos || []).map((c) => ({ ...c, recorrente: true })), ...((cfg?.meses || {})[mes] || []).map((c) => ({ ...c, recorrente: false }))];
  return lista.filter((c) => n(c.valor) > 0);
}
// Monta o DRE: lojas (com cnpj, partes, ads, devolucoes) e o Simples de cada CNPJ (efetiva). Imposto da loja = Simples do
// CNPJ × faturamento da loja quando o CNPJ tem alíquota; senão o imposto das vendas (% cadastrado na Empresa). Função pura: testada.
function dreDe({ lojas, cnpjs, custos }) {
  const fatCnpj = new Map();
  for (const l of lojas) fatCnpj.set(l.cnpj, (fatCnpj.get(l.cnpj) || 0) + l.faturamento);
  const efetiva = new Map(cnpjs.map((c) => [c.id, c.efetiva]));
  const porLoja = lojas.map((l) => {
    const ef = efetiva.get(l.cnpj);
    const imposto = ef != null ? r2(l.faturamento * ef) : l.imposto;
    const mc = r2(l.faturamento - l.tarifa - l.frete - l.produto - l.embalagem - imposto);
    const resultado = r2(mc - n(l.ads) - n(l.devolucoes));
    return { ...l, imposto, imposto_fonte: ef != null ? 'simples' : 'empresa', mc, margem_mc: l.faturamento ? mc / l.faturamento : null,
      resultado, margem: l.faturamento ? resultado / l.faturamento : null };
  });
  const fatTotal = lojas.reduce((s, l) => s + l.faturamento, 0);
  const soma = (ls, k) => r2(ls.reduce((s, l) => s + n(l[k]), 0));
  const campos = ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto', 'mc', 'ads', 'devolucoes', 'resultado'];
  const blocos = [...cnpjs, ...(lojas.some((l) => !cnpjs.some((c) => c.id === l.cnpj)) ? [{ id: '?', nome: 'Sem CNPJ' }] : [])].map((c) => {
    const ls = porLoja.filter((l) => (c.id === '?' ? !cnpjs.some((x) => x.id === l.cnpj) : l.cnpj === c.id));
    const fat = soma(ls, 'faturamento');
    const fixosProprios = custos.filter((x) => x.cnpj === c.id);
    const rateio = fatTotal > 0 ? fat / fatTotal : 0;
    const gerais = custos.filter((x) => !x.cnpj || !cnpjs.some((y) => y.id === x.cnpj)).map((x) => ({ ...x, valor: r2(n(x.valor) * rateio), rateado: true }));
    const fixos = [...fixosProprios.map((x) => ({ ...x, valor: r2(n(x.valor)) })), ...gerais].filter((x) => x.valor > 0);
    const tot = Object.fromEntries(campos.map((k) => [k, soma(ls, k)]));
    const custosFixos = r2(fixos.reduce((s, x) => s + x.valor, 0));
    const final = r2(tot.resultado - custosFixos);
    return { id: c.id, nome: c.nome, efetiva: c.efetiva ?? null, lojas: ls.map((l) => l.conta), ...tot, custos_fixos: custosFixos, fixos,
      resultado_final: final, margem_final: fat ? final / fat : null, margem_mc: fat ? tot.mc / fat : null };
  });
  const total = Object.fromEntries(campos.map((k) => [k, soma(porLoja, k)]));
  total.custos_fixos = r2(custos.reduce((s, x) => s + n(x.valor), 0));
  total.resultado_final = r2(total.resultado - total.custos_fixos);
  total.margem_final = total.faturamento ? total.resultado_final / total.faturamento : null;
  total.margem_mc = total.faturamento ? total.mc / total.faturamento : null;
  // ponto de equilíbrio: faturamento que paga os custos fixos com a margem depois de Ads e devoluções deste mês
  const mPos = total.faturamento ? total.resultado / total.faturamento : null;
  total.equilibrio = mPos > 0 && total.custos_fixos > 0 ? r2(total.custos_fixos / mPos) : null;
  return { lojas: porLoja, cnpjs: blocos, total };
}
// Custos digitados na tela -> o que fica gravado. Recusa valor fora de 0–10 mi e mais de 100 linhas. Pura: testada.
function validarCustos(b, mesesOk = /^\d{4}-\d{2}$/) {
  const linha = (c) => {
    const nome = String(c?.nome ?? '').trim().slice(0, 60), valor = Number(String(c?.valor ?? '').replace(',', '.'));
    if (!nome && !c?.valor) return null;
    if (!nome) throw erro('Dê um nome a cada custo.');
    if (!Number.isFinite(valor) || valor < 0 || valor > 1e7) throw erro(`Custo "${nome}": informe um valor entre R$ 0 e R$ 10 milhões.`);
    return { nome, valor: r2(valor), cnpj: String(c?.cnpj ?? '').slice(0, 10) };
  };
  const fixos = (Array.isArray(b?.fixos) ? b.fixos : []).map(linha).filter(Boolean);
  const meses = {};
  for (const [m, ls] of Object.entries(b?.meses && typeof b.meses === 'object' ? b.meses : {})) {
    if (!mesesOk.test(m)) continue;
    const v = (Array.isArray(ls) ? ls : []).map(linha).filter(Boolean);
    if (v.length) meses[m] = v;
  }
  if (fixos.length > 100 || Object.values(meses).some((v) => v.length > 100)) throw erro('No máximo 100 custos por lista.');
  return { fixos, meses };
}

// ---------- placar ----------
// Promoções numa loja pelas vendas que trazem a promoção (Leroy, Magalu, Amazon): faturamento com promoção, desconto dado e
// as promoções que mais venderam. resultado = campanhas-canais.js#resultadoPromocoes. Função pura: testada.
function placarPromocoesDe(linhas, resultado) {
  const validas = linhas.filter((l) => l.valida);
  const com = validas.filter((l) => (l.promocoes || []).length);
  const fat = validas.reduce((s, l) => s + n(l.faturamento), 0), fatCom = com.reduce((s, l) => s + n(l.faturamento), 0);
  const lucroCom = com.filter((l) => l.lucro != null), lucroSem = validas.filter((l) => !(l.promocoes || []).length && l.lucro != null);
  const margem = (ls) => { const f = ls.reduce((s, l) => s + n(l.faturamento), 0); return f ? ls.reduce((s, l) => s + l.lucro, 0) / f : null; };
  return { faturamento: r2(fatCom), participacao: fat ? fatCom / fat : null, pedidos: new Set(com.map((l) => l.pedido)).size,
    desconto: r2(resultado.reduce((s, p) => s + n(p.desconto), 0)), margem_com: margem(lucroCom), margem_sem: margem(lucroSem),
    top: resultado.slice().sort((a, b) => b.faturamento - a.faturamento).slice(0, 5)
      .map((p) => ({ nome: p.nome || p.id || 'Promoção', pedidos: p.pedidos, faturamento: p.faturamento, desconto: p.desconto, lucro: p.sem_lucro ? null : p.lucro })) };
}
// Promoções do ML (promocoes.js#montarResultado): linhas com tipo = com promoção. Função pura: testada.
function placarPromocoesMl(linhas) {
  const com = linhas.filter((l) => l.tipo);
  const fat = linhas.reduce((s, l) => s + n(l.faturamento), 0), fatCom = com.reduce((s, l) => s + n(l.faturamento), 0);
  return { faturamento: r2(fatCom), participacao: fat ? fatCom / fat : null, pedidos: com.reduce((s, l) => s + n(l.pedidos), 0),
    desconto: r2(com.reduce((s, l) => s + n(l.desconto_vendedor), 0)), desconto_ml: r2(com.reduce((s, l) => s + n(l.desconto_ml), 0)),
    top: com.slice().sort((a, b) => b.faturamento - a.faturamento).slice(0, 5)
      .map((p) => ({ nome: p.nome || p.tipo_nome, tipo: p.tipo_nome, pedidos: p.pedidos, faturamento: r2(p.faturamento), desconto: r2(p.desconto_vendedor), retorno: p.retorno })) };
}
// Ads + vendas da loja -> ROAS, TACOS e lucro depois do Ads. ads = { gasto, vendas } ou null. Função pura: testada.
function placarAdsDe(ads, vendas) {
  if (!ads) return null;
  const gasto = r2(n(ads.gasto)), atribuidas = r2(n(ads.vendas));
  return { gasto, vendas: atribuidas, roas: gasto > 0 ? atribuidas / gasto : null, acos: atribuidas > 0 ? gasto / atribuidas : null,
    tacos: vendas.faturamento > 0 ? gasto / vendas.faturamento : null,
    lucro_pos_ads: vendas.lucro == null ? null : r2(vendas.lucro - gasto),
    margem_pos_ads: vendas.lucro == null || !vendas.faturamento ? null : (vendas.lucro - gasto) / vendas.faturamento };
}

// ---------- rotas ----------
// deps: D, routes, CTX, vendasEmCache(dias) -> { promessa, dados: { grupos, erros } } (as vendas de todas as lojas, server.js),
// amazon (repasses), shopeeVendas (sincronizar), emPromocao() (ids do ML em promoção, na conta do contexto), leroy/magaluConectada.
function criar({ D, routes, CTX, vendasEmCache, amazon, shopeeVendas, emPromocao, leroyConectada, magaluConectada }) {
  const u = (p) => new URL(p, 'http://painel');
  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // Leitura em segundo plano guardada por 10 min (como a Margem baixa): a tela pergunta de novo até ficar pronta.
  const cache = new Map();
  async function emSegundoPlano(chave, fn, recarregar = false, validade = 10 * 60e3) {
    let c = cache.get(chave);
    if (!c || (!c.rodando && (Date.now() - c.em > validade || recarregar))) {
      const novo = { em: Date.now(), rodando: true, dados: c?.dados || null };
      novo.promessa = fn().then((d) => { novo.dados = d; novo.lido_em = new Date().toISOString(); novo.erro = null; })
        .catch((e) => { novo.erro = e.message; }).finally(() => { novo.rodando = false; });
      cache.set(chave, novo); c = novo;
    }
    if (c.rodando) await Promise.race([c.promessa, esperar(20000)]);
    if (!c.dados) return { pronto: false, erro: c.erro || null };
    return { pronto: !c.rodando, lido_em: c.lido_em || null, ...c.dados };
  }
  const tenta = async (erros, nome, fn) => { try { return await fn(); } catch (e) { erros.push(`${nome}: ${e.message}`); return null; } };
  const contaMetas = (conta) => conta.replace(/^shopee-/, 'shopee:');

  async function lerCaixa() {
    const lojas = [], erros = [];
    for (const c of D.contasListar()) {
      const r = await tenta(erros, `Mercado Livre · ${c.nickname}`, () => routes['GET /api/financeiro'](u(`/api/financeiro?conta=${c.ml_user_id}&dias=30`)));
      if (!r) continue;
      const t = r.totais, prox = (r.a_receber_por_dia || [])[0] || null;
      lojas.push({ loja: `Mercado Livre · ${c.nickname}`, conta: `ml:${c.ml_user_id}`, a_receber: t.a_receber, proximos_7: t.a_receber_7, retido: t.retido,
        liberado_30: t.liberado, proximo: prox ? { data: prox.dia, valor: prox.valor } : null, por_dia: (r.a_receber_por_dia || []).slice(0, 45),
        qtd_a_receber: t.qtd_a_receber, qtd_retido: t.qtd_retido, link: '/financeiro.html',
        nota: 'Mercado Pago: cada venda libera numa data; retido = liberação vencida e ainda presa (reclamação, contestação).' });
    }
    for (const s of D.shopeeLojasListar()) {
      const t = await tenta(erros, `Shopee · ${s.nome || s.shop_id}`, async () => {
        await shopeeVendas.sincronizar(s.shop_id).catch(() => null);
        const rows = D.shopeeVendasPeriodo(s.shop_id, new Date(Date.now() - 120 * 864e5).toISOString(), '9999');
        const SV = require('./shopee-vendas.js');
        const base90 = D.shopeeVendasPeriodo(s.shop_id, new Date(Date.now() - 90 * 864e5).toISOString(), '9999');
        return caixaShopeeDe(rows, { proporcao: SV.proporcaoDe(base90), frete_medio: SV.freteMedioDe(base90), precoDe: SV.precoDe });
      });
      if (t) lojas.push({ loja: `Shopee · ${s.nome || s.shop_id}`, conta: `shopee-${s.shop_id}`, ...t, proximos_7: null, proximo: null,
        nota: 'A Shopee libera o repasse na carteira quando o pedido é concluído (o comprador confirma ou o prazo vence).'
          + (t.estimados ? ` ${t.estimados} pedido(s) ainda sem repasse: valor estimado pela média da loja.` : '') });
    }
    if (D.configLer('amazon_refresh_token')) {
      const r = await tenta(erros, 'Amazon', () => amazon.repasses());
      if (r) lojas.push({ loja: 'Amazon', conta: 'amazon', a_receber: r2(r.acumulando + r.a_caminho_valor), proximos_7: r.a_caminho_valor, retido: 0,
        liberado_30: r.pago_30, proximo: r.proximo ? { data: diaBR(r.proximo), valor: r.acumulando } : null, a_caminho: r.a_caminho_valor,
        ultimos: r.pagos.slice(0, 4).map((g) => ({ data: g.pago_em ? diaBR(g.pago_em) : null, valor: g.valor })),
        nota: 'Amazon: o ciclo aberto junta as vendas e deposita a cada ~14 dias; "a caminho" = ciclo fechado ainda não creditado no banco.' });
    }
    if (leroyConectada()) {
      const r = await tenta(erros, 'Leroy Merlin', () => routes['GET /api/leroy/repasses'](u('/api/leroy/repasses')));
      if (r) lojas.push({ loja: 'Leroy Merlin', conta: 'leroy', ...caixaLeroyDe(r), link: '/leroy.html',
        nota: 'Leroy: o ciclo fecha dia 10 e 25 e paga 25 dias depois (ciclo fechado conta como pago depois da data prevista, como na tela da Leroy); "aguardando entrega" entra no ciclo quando o cliente recebe.' });
    }
    if (magaluConectada()) {
      const t = await tenta(erros, 'Magalu', async () => {
        const peds = D.magaluPedidosPeriodo(new Date(Date.now() - 120 * 864e5).toISOString(), '9999');
        return caixaMagaluDe(peds, D.magaluFinanceiroDe(peds.map((p) => p.code)));
      });
      if (t) lojas.push({ loja: 'Magalu', conta: 'magalu', a_receber: t.a_receber, proximos_7: null, retido: 0, liberado_30: null,
        qtd_a_receber: t.qtd_a_receber, entregue_30: t.entregue_30, estimados: t.estimados, status_financeiro: t.status, proximo: { data: proximaSegunda(), valor: null },
        nota: 'Magalu deposita toda segunda-feira e não informa se cada pedido já foi pago: a receber = pedidos ainda não entregues; os entregues nos últimos 30 dias aparecem à parte (podem já ter caído).'
          + (t.estimados ? ` ${t.estimados} pedido(s) sem análise financeira ainda: faturamento − comissão (estimado).` : '') });
    }
    return { lojas, total: totaisCaixa(lojas), erros };
  }

  // Custos fixos (estado dre_custos) e os CNPJs da tela Metas.
  const custosCfg = () => { try { return JSON.parse(D.configLer('dre_custos') || 'null') || { fixos: [], meses: {} }; } catch { return { fixos: [], meses: {} }; } };
  const DIAS = [7, 15, 30, 60, 90];
  async function lerDre(mes) {
    const j = janelaMes(mes);
    const precisa = Math.ceil((Date.now() - Date.parse(j.de)) / 864e5);
    const dias = DIAS.find((d) => d >= precisa);
    if (!dias) throw erro('O DRE pelo painel cobre os últimos 3 meses.');
    const erros = [];
    const c = vendasEmCache(dias);
    await c.promessa;
    if (!c.dados) throw erro(c.erro || 'Não consegui ler as vendas.', 502);
    erros.push(...c.dados.erros);
    // CNPJs e Simples pela tela Metas (mês do DRE)
    const [ano, m] = mes.split('-').map(Number);
    const metas = await tenta(erros, 'Metas (Simples)', () => routes['GET /api/metas'](u(`/api/metas?ano=${ano}&mes=${m}`)));
    const cnpjs = (metas?.cnpjs || []).map((x) => ({ id: x.id, nome: x.nome, canais: x.canais, efetiva: x.simples?.efetiva ?? null, faixa: x.simples?.faixa ?? null }));
    const cnpjDe = (conta) => cnpjs.find((x) => x.canais.includes(contaMetas(conta)))?.id || '?';
    const doMes = (data) => data && data >= j.de && data < j.ate;
    const lojas = [];
    for (const g of c.dados.grupos) {
      const s = somaDoMes(g.linhas, j);
      let ads = null, adsNota = null, devol = null, devNota = null;
      const ml = /^ml:(\d+)$/.exec(g.conta), sh = /^shopee-(\d+)$/.exec(g.conta);
      if (ml) {
        const h = await tenta(erros, `${g.loja} (Ads)`, () => CTX.comConta(Number(ml[1]), () => routes['GET /api/ads/historico'](u(`/api/ads/historico?dias=${Math.min(90, Math.max(7, dias))}`))));
        if (h?.habilitado) ads = r2((h.serie || []).filter((d) => doMes(`${d.data}T12:00:00Z`)).reduce((a, d) => a + n(d.investimento), 0));
        else if (h) { ads = 0; adsNota = 'sem anunciante'; }
        const dv = await tenta(erros, `${g.loja} (devoluções)`, () => CTX.comConta(Number(ml[1]), () => routes['GET /api/devolucoes'](u(`/api/devolucoes?dias=${dias}`))));
        if (dv) {
          const custo = (dv.itens || []).filter((x) => doMes(x.criada_em)).reduce((a, x) => a + n(x.custo?.total) + n(x.custo?.fretes), 0);
          const cred = (dv.creditos || []).filter((x) => doMes(x.data)).reduce((a, x) => a + n(x.valor), 0);
          devol = r2(custo - cred); devNota = 'custo das reclamações abertas no mês − crédito do ML';
        }
      } else if (sh) {
        const h = await tenta(erros, `${g.loja} (Ads)`, () => routes['GET /api/shopee/ads'](u(`/api/shopee/ads?dias=30&loja=${sh[1]}`)));
        if (h) {
          ads = r2((h.dias || []).filter((d) => doMes(`${d.dia}T12:00:00Z`)).reduce((a, d) => a + n(d.gasto), 0));
          if (Date.parse(j.de) < Date.now() - 30 * 864e5) adsNota = 'a Shopee dá só os últimos 30 dias de Ads';
        }
        devol = 0; devNota = 'a devolução da Shopee já sai do repasse (está nas vendas)';
      } else {
        adsNota = g.conta === 'amazon' ? 'Amazon Ads só conectado (sem leitura do gasto ainda)' : 'sem Ads integrado';
        const dv = await tenta(erros, `${g.loja} (devoluções)`, () => routes[`GET /api/${g.conta}/devolucoes`](u(`/api/${g.conta}/devolucoes?dias=90`)));
        if (dv) { devol = r2((dv.devolucoes || []).filter((x) => doMes(x.data || x.data_venda)).reduce((a, x) => a + n(x.custo), 0)); devNota = 'reembolsos do mês'; }
      }
      lojas.push({ loja: g.loja, conta: g.conta, cnpj: cnpjDe(g.conta), ...s, ads, ads_nota: adsNota, devolucoes: devol, devolucoes_nota: devNota });
    }
    const custos = custosDoMes(custosCfg(), mes);
    return { mes, de: j.de, ate: j.ate, parcial: Date.now() < Date.parse(j.ate), ...dreDe({ lojas, cnpjs, custos }), custos_cfg: custosCfg(), erros };
  }

  async function lerPlacar(dias) {
    const erros = [];
    const c = vendasEmCache(dias);
    await c.promessa;
    if (!c.dados) throw erro(c.erro || 'Não consegui ler as vendas.', 502);
    erros.push(...c.dados.erros);
    const CC = require('./campanhas-canais.js');
    const lojas = [];
    for (const g of c.dados.grupos) {
      const val = g.linhas.filter((l) => l.valida);
      const comLucro = val.filter((l) => l.lucro != null);
      const fat = r2(val.reduce((s, l) => s + n(l.faturamento), 0));
      const vendas = { faturamento: fat, pedidos: new Set(val.map((l) => l.pedido)).size,
        lucro: comLucro.length ? r2(comLucro.reduce((s, l) => s + l.lucro, 0)) : null };
      vendas.margem = vendas.lucro != null && fat ? vendas.lucro / fat : null;
      let promo = null, promoNota = null, ads = null, adsNota = null;
      const ml = /^ml:(\d+)$/.exec(g.conta), sh = /^shopee-(\d+)$/.exec(g.conta);
      if (ml) {
        const id = Number(ml[1]);
        const r = await tenta(erros, `${g.loja} (promoções)`, () => CTX.comConta(id, () => routes['GET /api/promocoes/resultado'](u(`/api/promocoes/resultado?dias=${dias}`))));
        if (r) promo = placarPromocoesMl(r.linhas || []);
        // em promoção (em andamento) e sem nenhuma venda no período: desconto que não está trazendo venda
        const ids = await tenta(erros, `${g.loja} (anúncios em promoção)`, () => CTX.comConta(id, () => emPromocao()));
        if (ids && promo) {
          const venderam = new Set(val.map((l) => l.item_id));
          promo.em_promocao = ids.length;
          promo.parados = ids.filter((x) => !venderam.has(x)).length;
        }
        const h = await tenta(erros, `${g.loja} (Ads)`, () => CTX.comConta(id, () => routes['GET /api/ads/historico'](u(`/api/ads/historico?dias=${Math.max(7, dias)}`))));
        if (h?.habilitado) ads = { gasto: h.total?.investimento, vendas: h.total?.receita };
        else if (h) adsNota = 'sem anunciante no Mercado Ads';
      } else if (sh) {
        promoNota = 'a Shopee não diz na venda qual desconto foi usado: o resultado por campanha está em Campanhas';
        const h = await tenta(erros, `${g.loja} (Ads)`, () => routes['GET /api/shopee/ads'](u(`/api/shopee/ads?dias=${dias}&loja=${sh[1]}`)));
        if (h) ads = { gasto: h.total?.gasto, vendas: h.total?.vendas };
      } else {
        let linhas = g.linhas;
        if (g.conta === 'amazon') {
          const promos = new Map();
          for (const l of D.amazonLancPeriodo(new Date(Date.now() - (dias + 30) * 864e5).toISOString(), '9999')) {
            if (l.tipo !== 'venda' || !l.promocoes || !l.pedido) continue;
            const k = `${l.pedido}|${l.sku}`;
            promos.set(k, [...(promos.get(k) || []), ...JSON.parse(l.promocoes).map((p) => ({ ...p, nome: p.id || 'Promoção sem identificação' }))]);
          }
          // pedido de 2+ unidades: um lançamento (e uma promoção) por unidade — junta pela promoção, somando o desconto
          const juntar = (ps) => [...ps.reduce((m, p) => { const x = m.get(p.id || '') || { ...p, valor: 0 }; x.valor = r2(x.valor + n(p.valor)); return m.set(p.id || '', x); }, new Map()).values()];
          linhas = linhas.map((l) => ({ ...l, promocoes: juntar(promos.get(`${l.pedido}|${l.sku}`) || []) }));
        }
        promo = placarPromocoesDe(linhas, CC.resultadoPromocoes(linhas));
        adsNota = g.conta === 'amazon' ? 'Amazon Ads só conectado (sem leitura do gasto ainda)' : 'sem Ads integrado';
      }
      lojas.push({ loja: g.loja, conta: g.conta, vendas, promocoes: promo, promocoes_nota: promoNota, ads: placarAdsDe(ads, vendas), ads_nota: adsNota });
    }
    const soma = (f) => r2(lojas.reduce((s, l) => s + n(f(l)), 0));
    const fat = soma((l) => l.vendas.faturamento), gasto = soma((l) => l.ads?.gasto);
    return { dias, lojas, erros, total: { faturamento: fat, lucro: soma((l) => l.vendas.lucro), promo_faturamento: soma((l) => l.promocoes?.faturamento),
      desconto: soma((l) => l.promocoes?.desconto), ads_gasto: gasto, ads_vendas: soma((l) => l.ads?.vendas), tacos: fat ? gasto / fat : null,
      lucro_pos_ads: r2(soma((l) => l.vendas.lucro) - gasto), parados: soma((l) => l.promocoes?.parados) } };
  }

  const mesAtual = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
  const rotas = {
    'GET /api/caixa': async (url) => emSegundoPlano('caixa', lerCaixa, url.searchParams.get('recarregar') === '1'),
    'GET /api/dre': async (url) => {
      const mes = url.searchParams.get('mes') || mesAtual();
      if (!janelaMes(mes)) throw erro('Mês inválido (AAAA-MM).');
      const r = await emSegundoPlano(`dre:${mes}`, () => lerDre(mes), url.searchParams.get('recarregar') === '1');
      return { ...r, mes, custos_cfg: custosCfg() };
    },
    'PUT /api/dre/custos': async (_u, b) => {
      const cfg = validarCustos(b);
      D.configGravar('dre_custos', JSON.stringify(cfg));
      for (const k of [...cache.keys()]) if (k.startsWith('dre:')) cache.delete(k);
      return { ok: true, ...cfg };
    },
    'GET /api/placar': async (url) => {
      const dias = [7, 15, 30].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30;
      const r = await emSegundoPlano(`placar:${dias}`, () => lerPlacar(dias), url.searchParams.get('recarregar') === '1');
      return { dias, ...r };
    },
  };
  return { rotas };
}

module.exports = { criar, caixaShopeeDe, caixaMagaluDe, caixaLeroyDe, proximaSegunda, totaisCaixa, janelaMes, somaDoMes, custosDoMes, dreDe, validarCustos,
  placarPromocoesDe, placarPromocoesMl, placarAdsDe };
