'use strict';
// Calculadora reversa (tela public/calculadora.html): dado o PREÇO DE VENDA e a MARGEM desejada,
// quanto sobra para pagar no produto em cada marketplace — e a quebra de tarifa, frete, imposto
// e embalagem. Custo máximo = preço − tarifa − frete − imposto − embalagem − margem × preço.
//
// De onde vem cada número:
//   - Mercado Livre (por conta): tarifa de /sites/MLB/listing_prices (categoria + tipo de anúncio:
//     a do anúncio escolhido, a digitada ou a prevista pelo nome do produto). Frete: do anúncio
//     do produto (achado pelo SKU) ou escolhido: médio das vendas dele ou estimativa do ML; sem
//     anúncio, o frete médio por unidade das vendas Mercado Envios (não Flex) da conta na MESMA
//     faixa (abaixo/acima de R$ 79), 60 dias — medido em 06/10/2026: o vendedor paga frete também
//     abaixo de R$ 79 (média R$ 11,51 por envio xd_drop_off; R$ 30,31 acima);
//     Flex = custo da entrega (empresa.entrega_flex) − bônus Flex médio da conta.
//   - Shopee: a tabela medida em 562 pedidos (shopee-vendas.js#taxaFixaDe): comissão + transação =
//     20% até R$ 79,99 e 14% acima, mais a taxa fixa por unidade (R$ 4,50 / 16 / 20 / 26) e R$ 0,49
//     de Devolução Fácil por pedido. Frete: Shopee Xpress a Shopee paga; Entrega Direta ela repassa
//     o que o vendedor paga (medido: R$ 8 em 208 de 215 pedidos) — custo líquido 0.
//   - Amazon: a média real do financeiro dela (taxasDosLancamentos, 92 dias) do SKU, ou do canal
//     (envio próprio ou FBA) quando o SKU não vendeu. Envio próprio: frete = etiqueta média comprada na
//     Amazon; FBA: frete = tarifa de envio do FBA por unidade + a parte da armazenagem e do envio ao armazém.
// Dados da Amazon não vão para o MCP: esta rota não tem ferramenta MCP.
const C = require('./custos.js');
const A = require('./amazon.js');
const r2 = (v) => Math.round(v * 100) / 100;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Shopee: comissão + transação e taxa fixa por unidade pela faixa do preço (desde 01/10/2026). Função pura: testada.
function tarifaShopee(preco, quantidade = 1) {
  const pct = preco < 80 ? 20 : 14;
  const fixa = preco < 80 ? 4.5 : preco < 100 ? 16 : preco < 200 ? 20 : 26;
  return { pct, fixa_un: fixa, pedido: 0.49, valor: r2(preco * pct / 100 + fixa + 0.49 / quantidade) };
}

// A conta reversa e a quebra. Função pura: testada.
function contaReversa({ preco, margemPct = 0, tarifa = 0, frete = 0, impostoPct = 0, embalagem = 0, outros = 0, custoAtual = null }) {
  const imposto = r2(preco * impostoPct / 100);
  const lucroDesejado = r2(preco * margemPct / 100);
  const despesas = r2(tarifa + frete + imposto + embalagem + outros);
  const custoMaximo = r2(preco - despesas - lucroDesejado);
  const out = { preco: r2(preco), tarifa: r2(tarifa), frete: r2(frete), imposto, imposto_pct: impostoPct, embalagem: r2(embalagem), outros: r2(outros),
    despesas, lucro_desejado: lucroDesejado, custo_maximo: custoMaximo, sobra_sem_lucro: r2(preco - despesas) };
  if (custoAtual != null) {
    const lucro = r2(preco - despesas - custoAtual);
    Object.assign(out, { custo_atual: r2(custoAtual), lucro_atual: lucro, margem_atual: preco > 0 ? lucro / preco : null,
      folga: r2(custoMaximo - custoAtual) });
  }
  return out;
}

// Tarifa digitada (%): "11,5", "11.5" ou 11.5, de 0 a 60; fora disso null. Função pura: testada.
function pctValido(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 60 ? r2(n) : null;
}

// Frete digitado (R$ por venda): "12,50" ou 12.5, de 0 a 10.000; fora disso null. Função pura: testada.
function freteValido(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? r2(n) : null;
}

// Frete do cartão: o digitado neste cálculo › o padrão salvo para o canal › o calculado pelo painel
// (que fica em frete_calculado para comparar). Função pura: testada.
// O mesmo vale para a embalagem (comEmbalagem). Funções puras: testadas.
function comDigitado(c, campo, digitado, padrao) {
  const valor = digitado ?? padrao;
  const base = { [`${campo}_calculado`]: r2(c[campo] ?? 0), [`${campo}_padrao`]: padrao,
    [`${campo}_origem`]: digitado != null ? 'editado' : padrao != null ? 'padrao' : 'calculado' };
  if (valor == null) return { ...c, ...base };
  const antes = `calculado pelo painel: R$ ${(c[campo] ?? 0).toFixed(2).replace('.', ',')}`;
  const fonte = c[`${campo}_fonte`];
  return { ...c, ...base, [campo]: valor,
    [`${campo}_fonte`]: `${digitado != null ? 'digitado neste cálculo' : 'padrão salvo'} · ${antes}${fonte ? ` (${fonte})` : ''}` };
}
const comFrete = (c, digitado, padrao) => comDigitado(c, 'frete', digitado, padrao);
const comEmbalagem = (c, digitado, padrao) => comDigitado(c, 'embalagem', digitado, padrao);

function criar({ D, ml, amazon = null }) {
  const empresaDe = (chave, reserva) => C.lerEmpresa(D.configLer(`empresa:${chave}`) || (reserva ? D.configLer(`empresa:${reserva}`) : null));
  const primeiraConta = () => D.contasListar()[0]?.ml_user_id || null;

  // Categoria prevista pelo nome (busca pública do ML), guardada em memória.
  const previstas = new Map();
  async function preverCategoria(nome) {
    if (!nome) return null;
    if (!previstas.has(nome)) {
      const r = await fetch(`https://api.mercadolibre.com/sites/MLB/domain_discovery/search?limit=1&q=${encodeURIComponent(nome)}`).then((x) => x.json()).catch(() => []);
      previstas.set(nome, Array.isArray(r) && r[0] ? { id: r[0].category_id, nome: r[0].category_name } : null);
    }
    return previstas.get(nome);
  }

  // Frete médio por unidade das vendas Mercado Envios (não Flex) da conta na faixa do preço, 60 dias.
  function freteMedioML(contaId, preco, itemId = null) {
    const r = D.db.prepare(`SELECT SUM(f.custo) AS custo, SUM(u.qtd) AS unidades, COUNT(*) AS n FROM fretes f
      JOIN (SELECT envio_id, SUM(quantidade) AS qtd FROM vendas WHERE ml_user_id=? AND data >= ? AND (preco_unit >= 79) = ? AND (? IS NULL OR item_id = ?)
        AND envio_id IS NOT NULL AND status IN ('paid','partially_refunded') GROUP BY envio_id) u ON u.envio_id = f.envio_id
      LEFT JOIN envio_logistica g ON g.envio_id = f.envio_id WHERE COALESCE(g.tipo, '') <> 'self_service'`)
      .get(contaId, new Date(Date.now() - 60 * 864e5).toISOString(), preco >= 79 ? 1 : 0, itemId, itemId);
    return r?.unidades > 0 ? { valor: r.custo / r.unidades, amostra: r.n } : null;
  }

  // Anúncio da conta com EXATAMENTE os mesmos produtos do SKU (pela composição guardada em
  // produtos.payload) ou, sem esse, um que CONTENHA todos eles (só serve para a categoria);
  // havendo vários, o que mais vendeu em 60 dias. { id, exato }.
  function anuncioDoSku(contaId, sku) {
    const nums = C.componentes(sku).sort((a, b) => a - b);
    if (!nums.length) return null;
    const alvo = nums.join('.');
    const linhas = D.db.prepare(`SELECT item_id, payload FROM produtos WHERE ml_user_id=? AND status='active' AND payload LIKE ?`)
      .all(contaId, `%"numero":${nums[0]},%`);
    const iguais = [], contem = [];
    for (const l of linhas) {
      let pl; try { pl = JSON.parse(l.payload); } catch { continue; }
      const comps = (pl.composicao || []).map((c) => (c.produtos || []).map((x) => x.numero));
      if (comps.some((ns) => ns.slice().sort((a, b) => a - b).join('.') === alvo)) iguais.push(l.item_id);
      else if (comps.some((ns) => nums.every((n) => ns.includes(n)))) contem.push(l.item_id);
    }
    const lista = iguais.length ? iguais : contem;
    if (!lista.length) return null;
    const desde = new Date(Date.now() - 60 * 864e5).toISOString();
    const vend = new Map(D.db.prepare(`SELECT item_id, SUM(quantidade) AS u FROM vendas WHERE ml_user_id=? AND data >= ? AND item_id IN (${lista.map(() => '?').join(',')}) GROUP BY item_id`)
      .all(contaId, desde, ...lista).map((r) => [r.item_id, r.u]));
    return { id: lista.sort((a, b) => (vend.get(b) || 0) - (vend.get(a) || 0))[0], exato: !!iguais.length };
  }
  // Categoria em que a conta mais vendeu em 60 dias (último recurso para a tarifa).
  function categoriaMaisVendida(contaId) {
    return D.db.prepare(`SELECT p.category_id AS c FROM vendas v JOIN produtos p ON p.item_id = v.item_id WHERE v.ml_user_id=? AND v.data >= ?
      AND p.category_id IS NOT NULL GROUP BY p.category_id ORDER BY SUM(v.quantidade) DESC LIMIT 1`).get(contaId, new Date(Date.now() - 60 * 864e5).toISOString())?.c || null;
  }

  async function canalML(conta, p) {
    const id = conta.ml_user_id;
    const empresa = empresaDe(id);
    const avisos = [];
    const lerItem = async (iid) => {
      const it = await ml(`/items/${iid}?attributes=id,title,category_id,listing_type_id,price,shipping,status,site_id,seller_id`, {}, id).catch(() => null);
      return it && Number(it.seller_id) === Number(id) ? it : null;   // anúncio de outra conta: vale só para a conta dona
    };
    let item = p.item ? await lerItem(p.item) : null, parecido = null;
    if (!item && p.sku) {
      const auto = anuncioDoSku(id, p.sku);
      if (auto?.exato) { item = await lerItem(auto.id); if (item) avisos.push(`Tarifa e frete do seu anúncio ${item.id}, que tem este produto.`); }
      else if (auto) { parecido = await lerItem(auto.id); if (parecido) avisos.push(`Categoria do seu anúncio ${parecido.id}, que tem este produto num kit.`); }
    }
    let categoria = item?.category_id || p.categoria || parecido?.category_id || null, nomeCat = null;
    if (!categoria) { const c = await preverCategoria(p.nome); categoria = c?.id || null; nomeCat = c?.nome || null; if (c) avisos.push(`Categoria prevista pelo nome: ${c.nome}.`); }
    if (!categoria) { categoria = categoriaMaisVendida(id); if (categoria) avisos.push('Tarifa da categoria em que a conta mais vende (sem anúncio deste produto).'); }
    const tipo = ['gold_special', 'gold_pro'].includes(p.tipo) ? p.tipo : item?.listing_type_id || parecido?.listing_type_id || 'gold_special';
    let tarifa = null;
    if (categoria) {
      const lp = await ml(`/sites/MLB/listing_prices?price=${p.preco}&listing_type_id=${tipo}&category_id=${categoria}`, {}, id).catch(() => null);
      const x = Array.isArray(lp) ? lp[0] : lp;
      const pct = x?.sale_fee_details?.percentage_fee, fixa = x?.sale_fee_details?.fixed_fee || 0;
      if (pct != null) tarifa = { pct, fixa, valor: r2(p.preco * pct / 100 + fixa) };
    }
    // Tarifa digitada: a desta conta (campo do cartão, só neste cálculo) › a padrão salva da conta
    // (`calc_tarifa_ml:{id}`) › a da categoria no ML. A da categoria fica como referência.
    const categoriaPct = tarifa?.pct ?? null;
    const digitada = p.tarifas?.[id] ?? pctValido(D.configLer(`calc_tarifa_ml:${id}`));
    if (digitada != null) {
      tarifa = { pct: digitada, fixa: 0, valor: r2(p.preco * digitada / 100) };
      tarifa.origem = p.tarifas?.[id] != null ? 'editada' : 'padrao';
    } else if (tarifa) tarifa.origem = 'categoria';
    if (tarifa) { tarifa.categoria_pct = categoriaPct; tarifa.padrao_pct = pctValido(D.configLer(`calc_tarifa_ml:${id}`)); }
    if (!tarifa) avisos.push('Sem a tarifa do ML: escolha um anúncio, informe a categoria ou digite a tarifa.');
    // frete
    let frete = 0, fonte;
    if (p.envio === 'flex') {
      const entrega = empresa.entrega_flex;
      const m = D.bonusFlexMedias(id);
      const bonus = p.preco >= 79 ? (m.com_custo ?? 0) : (m.sem_custo ?? m.com_custo ?? 0);
      if (entrega == null) { avisos.push('Informe o custo da entrega Flex na tela Empresa.'); frete = 0; fonte = 'Flex sem custo de entrega cadastrado'; }
      else { frete = Math.max(0, entrega - bonus); fonte = `Flex: entrega ${r2(entrega)} − bônus médio do ML ${r2(bonus)}`; }
    } else if (item && (item.price >= 79) === (p.preco >= 79)) {
      const f = freteMedioML(id, p.preco, item.id);   // só Mercado Envios: o Flex tem a conta dele
      if (f) { frete = f.valor; fonte = `médio das vendas Mercado Envios deste anúncio (${f.amostra} envio(s), 60 dias)`; }
      else {
        const est = await ml(`/users/${id}/shipping_options/free?item_id=${item.id}&free_shipping=true&verbose=true`, {}, id).catch(() => null);
        const v = est?.coverage?.all_country?.list_cost;
        if (Number.isFinite(v)) { frete = v; fonte = 'estimativa do ML para este anúncio'; }
      }
    }
    if (fonte == null) {
      const m = freteMedioML(id, p.preco);
      frete = m ? m.valor : 0;
      fonte = m ? `médio da conta ${p.preco >= 79 ? 'acima' : 'abaixo'} de R$ 79 (${m.amostra} envio(s), 60 dias)` : 'sem frete medido na conta';
    }
    const custosAnuncio = item ? D.custosDe([item.id])[item.id] : null;
    const embalagem = (custosAnuncio?.outros ?? empresa.embalagem_padrao ?? 0) + (custosAnuncio?.extra || 0);
    const origemTxt = { editada: 'digitada neste cálculo', padrao: 'padrão da conta', categoria: tipo === 'gold_pro' ? 'Premium' : 'Clássico' };
    return { id: `ml:${id}`, canal: 'ml', conta_ml: id, nome: `Mercado Livre — ${conta.nickname}`, tarifa,
      tarifa_txt: tarifa ? `${String(tarifa.pct).replace('.', ',')}%${tarifa.fixa ? ` + R$ ${tarifa.fixa.toFixed(2).replace('.', ',')}` : ''} (${origemTxt[tarifa.origem]})`
        + (tarifa.origem !== 'categoria' && categoriaPct != null ? ` · na categoria o ML cobra ${String(categoriaPct).replace('.', ',')}%` : '') : null,
      frete: r2(frete), frete_fonte: fonte, imposto_pct: C.impostoTotal(empresa), embalagem, categoria, categoria_nome: nomeCat,
      anuncio: item ? { id: item.id, titulo: item.title } : null, avisos };
  }

  function canalShopee(loja, p) {
    const empresa = empresaDe(`shopee-${loja.shop_id}`, primeiraConta());
    const t = tarifaShopee(p.preco);
    return { id: `shopee:${loja.shop_id}`, canal: 'shopee', nome: `Shopee — ${loja.nome || loja.shop_id}`, tarifa: { pct: t.pct, fixa: r2(t.fixa_un + t.pedido), valor: t.valor },
      tarifa_txt: `${t.pct}% + R$ ${t.fixa_un.toFixed(2).replace('.', ',')} por unidade + R$ 0,49 (Devolução Fácil)`,
      frete: 0, frete_fonte: 'Shopee Xpress: a Shopee paga; Entrega Direta: ela repassa o que você paga ao entregador',
      imposto_pct: C.impostoTotal(empresa), embalagem: empresa.embalagem_padrao || 0, avisos: [] };
  }

  // Lê as novidades do financeiro da Amazon antes (no máximo 8 s; a 1ª leitura de 92 dias leva ~1 min
  // e continua em segundo plano — o aviso pede para calcular de novo).
  async function canalAmazon(p) {
    if (!D.configLer('amazon_lwa_client_id')) return null;
    let lendo = false;
    if (amazon?.sincronizar) {
      const leitura = amazon.sincronizar().then(() => false, () => false);
      lendo = await Promise.race([leitura, new Promise((ok) => setTimeout(() => ok(true), 8000))]);
    }
    const proprio = D.configLer('empresa:amazon');
    const empresa = C.lerEmpresa(proprio || D.configLer(`empresa:${Number(D.configLer('amazon_empresa_conta')) || primeiraConta()}`));
    const taxas = A.taxasDosLancamentos(D.amazonLancPeriodo(new Date(Date.now() - 92 * 864e5).toISOString(), '9999'));
    const canal = p.amazon === 'FBA' ? 'FBA' : 'proprio';
    let m = p.sku ? taxas.mediaSku(p.sku, canal) : null, fonte = 'média deste SKU nas vendas da Amazon (92 dias)';
    if (!m) { m = taxas.mediaCanal(canal); fonte = `média das vendas ${canal === 'FBA' ? 'FBA' : 'com envio próprio'} da Amazon (92 dias)`; }
    if (!m) return { id: 'amazon', canal: 'amazon', nome: 'Amazon', tarifa: null, frete: 0, imposto_pct: C.impostoTotal(empresa), embalagem: 0,
      avisos: [lendo ? 'Lendo o financeiro da Amazon agora: calcule de novo em 1 minuto.' : 'Ainda sem vendas na Amazon para medir as taxas.'] };
    const pct = r2(m.tarifa_pct * 100);
    const din = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
    // FBA: a tarifa de envio por unidade (FBAPerUnitFulfillmentFee) é o frete do FBA — mostrada no
    // frete, com a armazenagem e o envio ao armazém. Envio próprio: a etiqueta média.
    const fba = canal === 'FBA';
    const avisos = [];
    if (lendo) avisos.push('Lendo o financeiro da Amazon agora: calcule de novo em 1 minuto para ver as taxas atualizadas.');
    if (!fba && !m.frete_un) avisos.push('Envio próprio sem etiqueta da Amazon: o frete que você paga à transportadora não passa por ela. Some em "Outros custos".');
    return { id: 'amazon', canal: 'amazon', nome: `Amazon — ${fba ? 'FBA' : 'envio próprio'}`,
      tarifa: { pct, fixa: fba ? 0 : r2(m.fixa_un), valor: r2(p.preco * m.tarifa_pct + (fba ? 0 : m.fixa_un)) },
      tarifa_txt: `${String(pct).replace('.', ',')}%${!fba && m.fixa_un ? ` + ${din(m.fixa_un)}` : ''} (${fonte})`,
      frete: r2(fba ? m.fixa_un + (m.armazem_un || 0) : m.frete_un),
      frete_fonte: fba
        ? `tarifa de envio do FBA ${din(m.fixa_un)} + armazenagem e envio ao armazém ${din(m.armazem_un || 0)} por unidade — ${fonte}`
        : `etiqueta comprada na Amazon — ${fonte}`,
      imposto_pct: C.impostoTotal(empresa), embalagem: fba ? 0 : (empresa.embalagem_padrao || 0), avisos };
  }

  const rotas = {
    'GET /api/calculadora': async (url) => {
      const q = url.searchParams;
      const num = (k) => { const v = Number(String(q.get(k) || '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
      const preco = num('preco');
      if (!(preco > 0) || preco > 1e6) throw erro('Informe o preço de venda.');
      const margem = num('margem') ?? 0;
      const outros = Math.max(0, num('outros') ?? 0);
      if (margem < -50 || margem > 90) throw erro('Margem entre -50% e 90%.');
      // produto: SKU (kit ou produto) da tabela de produtos
      const sku = (q.get('sku') || '').trim() || null;
      const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
      const cs = sku ? C.custoDoSku(sku, mapa) : null;
      const nome = cs?.componentes?.map((c) => c.nome).filter(Boolean).join(' + ') || (q.get('nome') || '').trim() || null;
      const item = /^MLB\d+$/i.test(q.get('item') || '') ? q.get('item').toUpperCase() : null;
      const categoria = /^MLB\d+$/i.test(q.get('categoria') || '') ? q.get('categoria').toUpperCase() : null;
      const p = { preco, sku, nome, item, categoria, tipo: q.get('tipo'), envio: q.get('envio') === 'flex' ? 'flex' : 'me', amazon: q.get('amazon'),
        tarifas: Object.fromEntries(D.contasListar().map((c) => [c.ml_user_id, pctValido(q.get(`t_${c.ml_user_id}`))]).filter(([, v]) => v != null)) };
      const so = q.get('canal');   // opcional: um canal só (ml:{id}, shopee:{loja}, amazon)
      const canais = [];
      for (const c of D.contasListar()) if (!so || so === `ml:${c.ml_user_id}`) canais.push(await canalML(c, p).catch((e) => ({ id: `ml:${c.ml_user_id}`, canal: 'ml', nome: `Mercado Livre — ${c.nickname}`, tarifa: null, avisos: [e.message] })));
      for (const l of D.shopeeLojasListar()) if (!so || so === `shopee:${l.shop_id}`) canais.push(canalShopee(l, p));
      if (!so || so === 'amazon') { const a = await canalAmazon(p); if (a) canais.push(a); }
      const custoAtual = cs?.custo ?? null;
      // frete editável em todos os canais; o padrão é por canal e tipo de envio
      const chaveFrete = (c) => (c.canal === 'ml' ? `${c.id}:${p.envio}` : c.canal === 'amazon' ? `amazon:${p.amazon === 'FBA' ? 'FBA' : 'proprio'}` : c.id);
      for (const [i, c] of canais.entries()) {
        const chave = chaveFrete(c);
        canais[i] = { ...comFrete(c, freteValido(q.get(`f_${c.id}`)), freteValido(D.configLer(`calc_frete:${chave}`))), frete_chave: chave };
        // embalagem: padrão por canal (na Amazon, por FBA ou envio próprio)
        const chaveEmb = c.canal === 'amazon' ? `amazon:${p.amazon === 'FBA' ? 'FBA' : 'proprio'}` : c.id;
        canais[i] = { ...comEmbalagem(canais[i], freteValido(q.get(`e_${c.id}`)), freteValido(D.configLer(`calc_embalagem:${chaveEmb}`))), embalagem_chave: chaveEmb };
      }
      return { preco, margem, outros, sku, produto: nome, custo_atual: custoAtual, faltando: cs?.faltando || [],
        canais: canais.map((c) => ({ ...c, conta: c.tarifa ? contaReversa({ preco, margemPct: margem, tarifa: c.tarifa.valor, frete: c.frete || 0,
          impostoPct: c.imposto_pct || 0, embalagem: c.embalagem || 0, outros, custoAtual }) : null })) };
    },
    // Busca de produtos (tabela de produtos) para o campo "Produto".
    'GET /api/calculadora/produtos': async (url) => {
      const t = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (t.length < 2) return { produtos: [] };
      return { produtos: D.catalogoListar().filter((p) => String(p.numero) === t || (p.nome || '').toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t))
        .slice(0, 15).map((p) => ({ numero: p.numero, sku: p.sku, nome: p.nome, custo: p.custo })) };
    },
    // Tarifa padrão de uma conta do ML na calculadora (null = volta a usar a da categoria).
    'POST /api/calculadora/tarifa': async (_u, b) => {
      const conta = D.contasListar().find((c) => String(c.ml_user_id) === String(b?.conta));
      if (!conta) throw erro('Conta do Mercado Livre não encontrada.');
      const pct = b?.pct == null || b.pct === '' ? null : pctValido(b.pct);
      if (b?.pct != null && b.pct !== '' && pct == null) throw erro('Tarifa entre 0% e 60%.');
      D.configGravar(`calc_tarifa_ml:${conta.ml_user_id}`, pct);
      return { ok: true, conta: conta.ml_user_id, pct };
    },
    // Frete padrão de um canal na calculadora (chave = frete_chave do cartão; null = volta ao calculado).
    'POST /api/calculadora/frete': async (_u, b) => {
      const chave = String(b?.chave || '');
      if (!/^(ml:\d+:(me|flex)|shopee:\d+|amazon:(FBA|proprio))$/.test(chave)) throw erro('Canal inválido.');
      const valor = b?.valor == null || b.valor === '' ? null : freteValido(b.valor);
      if (b?.valor != null && b.valor !== '' && valor == null) throw erro('Frete entre R$ 0 e R$ 10.000.');
      D.configGravar(`calc_frete:${chave}`, valor);
      return { ok: true, chave, valor };
    },
    // Embalagem padrão de um canal na calculadora (chave = embalagem_chave do cartão; null = volta à calculada).
    'POST /api/calculadora/embalagem': async (_u, b) => {
      const chave = String(b?.chave || '');
      if (!/^(ml:\d+|shopee:\d+|amazon:(FBA|proprio))$/.test(chave)) throw erro('Canal inválido.');
      const valor = b?.valor == null || b.valor === '' ? null : freteValido(b.valor);
      if (b?.valor != null && b.valor !== '' && valor == null) throw erro('Embalagem entre R$ 0 e R$ 10.000.');
      D.configGravar(`calc_embalagem:${chave}`, valor);
      return { ok: true, chave, valor };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, tarifaShopee, contaReversa, pctValido, freteValido, comFrete, comEmbalagem };
