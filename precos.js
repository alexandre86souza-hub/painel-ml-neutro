'use strict';
// Preço do anúncio: calculadora de preço pela margem desejada, GTIN e preço de atacado.
//
// Medido em 28/09/2026 numa conta real:
//   - a conta tem a tag "business": pode ter preço de atacado (PxQ B2B);
//   - anúncios já tinham atacado em VALOR FIXO (prices[] com min_purchase_unit e
//     user_type_business). O ML desliga esse formato em 27/10/2026 (endpoint
//     /prices/standard/quantity); o novo é em PERCENTUAL: POST /items/{id}/prices/
//     price-per-quantity com header x-version (de GET /items/{id}/prices?display_version=true),
//     até 5 faixas, quantidade 2..100, desconto crescente com a quantidade. A documentação
//     manda consultar /prices-per-quantity/v1/recommendations antes de gravar.
//   - GTIN mora no atributo GTIN do anúncio.

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- calculadora ----------
// Preço que deixa `margem` (% do preço) de lucro depois de tarifa, imposto, frete, custo e
// embalagem: P = (custo + embalagem + frete + tarifaFixa) / (1 - tarifa% - imposto% - margem%).
// A tarifa do ML muda por faixa de preço, então quem chama recalcula com a tarifa do preço
// encontrado até estabilizar (ver precoPelaMargem no criar).
function precoPara({ margemPct, custo, embalagem = 0, frete = 0, tarifaPct, tarifaFixa = 0, impostoPct = 0 }) {
  const fracao = 1 - (tarifaPct + impostoPct + margemPct) / 100;
  if (!(fracao > 0.02)) return null;   // margem + tarifa + imposto perto de 100%: não existe preço
  return r2((custo + (embalagem || 0) + (frete || 0) + (tarifaFixa || 0)) / fracao);
}

// Quanto sobra num preço (a mesma conta, ao contrário) — para mostrar a quebra.
function quebra({ preco, custo, embalagem = 0, frete = 0, tarifaPct, tarifaFixa = 0, impostoPct = 0 }) {
  const tarifa = r2(preco * tarifaPct / 100 + (tarifaFixa || 0));
  const imposto = r2(preco * impostoPct / 100);
  const lucro = r2(preco - tarifa - imposto - (frete || 0) - custo - (embalagem || 0));
  return { preco, tarifa, imposto, frete: r2(frete || 0), custo: r2(custo), embalagem: r2(embalagem || 0),
    lucro, margem: preco > 0 ? lucro / preco : null, markup: custo > 0 ? lucro / custo : null };
}

// ---------- GTIN ----------
// EAN-8, UPC-12, EAN-13 e GTIN-14 com dígito verificador (módulo 10).
function gtinValido(g) {
  const s = String(g || '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return false;
  const d = s.split('').map(Number);
  const dv = d.pop();
  const soma = d.reverse().reduce((t, n, i) => t + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === dv;
}

// ---------- atacado ----------
// Faixas vindas da tela: { quantidade, tipo: 'pct' | 'preco', valor }. Preço vira percentual
// sobre o preço base. Devolve as faixas já em % (ordenadas) ou lança o motivo.
function faixasAtacado(faixas, precoBase) {
  const lista = (Array.isArray(faixas) ? faixas : [])
    .filter((f) => f && String(f.quantidade ?? '').trim() !== '' && String(f.valor ?? '').trim() !== '');
  if (lista.length > 5) throw erro('O Mercado Livre aceita no máximo 5 faixas de atacado.');
  const out = lista.map((f) => {
    const q = Number(f.quantidade);
    if (!Number.isInteger(q) || q < 2 || q > 100) throw erro('A quantidade mínima de cada faixa vai de 2 a 100 unidades.');
    const v = Number(String(f.valor).replace(',', '.'));
    let pct;
    if (f.tipo === 'preco') {
      if (!(v > 0) || !(precoBase > 0)) throw erro(`Preço inválido na faixa de ${q} unidades.`);
      if (v >= precoBase) throw erro(`O preço de atacado (${q} un.) precisa ser menor que o preço do anúncio.`);
      pct = (1 - v / precoBase) * 100;
    } else {
      pct = v;
    }
    if (!(pct > 0 && pct < 100)) throw erro(`Desconto inválido na faixa de ${q} unidades (entre 0 e 100%).`);
    return { quantidade: q, pct: Math.round(pct * 100) / 100 };
  }).sort((a, b) => a.quantidade - b.quantidade);
  for (let i = 1; i < out.length; i++) {
    if (out[i].quantidade === out[i - 1].quantidade) throw erro(`Quantidade ${out[i].quantidade} repetida.`);
    if (out[i].pct <= out[i - 1].pct) throw erro('O desconto precisa aumentar conforme a quantidade aumenta.');
  }
  return out;
}

const corpoAtacado = (faixas) => ({
  price_per_quantity: faixas.map((f) => ({
    type: 'discount_percentage', percentage: f.pct,
    conditions: { context_restrictions: ['channel_marketplace', 'user_type_business'],
      min_purchase_unit: f.quantidade, eligible: true },
  })),
});

// Atacado atual de /items/{id}/prices: faixas em % (novo) e em valor fixo (antigo).
// Preço base: o "standard" sem quantidade mínima. Medido em 30/09/2026: anúncio com preço
// próprio no Mercado Shops tem DOIS (restrição channel_marketplace e channel_mshops) em vez
// de um sem restrição — vale o do marketplace; o do Shops só é preservado (`manter`).
function lerAtacado(p) {
  const semQtd = (p.prices || []).filter((x) => x.type === 'standard' && !x.conditions?.min_purchase_unit);
  const restr = (x) => x.conditions?.context_restrictions || [];
  const base = semQtd.find((x) => !restr(x).length) || semQtd.find((x) => restr(x).includes('channel_marketplace') && !restr(x).includes('user_type_business'));
  const fixas = (p.prices || []).filter((x) => x.type === 'standard' && x.conditions?.min_purchase_unit)
    .map((x) => ({ id: x.id, quantidade: x.conditions.min_purchase_unit, preco: x.amount,
      pct: base?.amount ? r2((1 - x.amount / base.amount) * 100) : null }))
    .sort((a, b) => a.quantidade - b.quantidade);
  const pct = (p.price_per_quantity || []).map((x) => ({ id: x.id, quantidade: x.conditions?.min_purchase_unit,
    pct: Number(x.percentage), preco: base?.amount ? r2(base.amount * (1 - Number(x.percentage) / 100)) : null }))
    .sort((a, b) => a.quantidade - b.quantidade);
  return { base: base ? { id: base.id, preco: base.amount } : null, fixas, pct, versao: p.version ?? null,
    manter: semQtd.map((x) => x.id) };   // preços sem quantidade (marketplace e Shops): ficam ao tirar o atacado antigo
}

// Resumo do atacado para a lista em massa: as faixas que valem (percentual; na falta, as de
// valor fixo do formato antigo) e o formato. Função pura: testada.
function resumoAtacado(a) {
  const faixas = a.pct.length ? a.pct : a.fixas;
  return { formato: a.pct.length ? 'pct' : a.fixas.length ? 'fixo' : null,
    faixas: faixas.map((f) => ({ quantidade: f.quantidade, pct: f.pct, preco: f.preco })) };
}

function criar({ ml, mlPaciente, emLotes, contaOuErro, exigeItemId, janela, freteDoItem, idsDaConta, D }) {
  const versaoPrecos = (id) => ml(`/items/${id}/prices?display_version=true`, { headers: { 'show-all-prices': 'true' } });

  // Grava (ou, com lista vazia, remove) a tabela de atacado em percentual de UM anúncio.
  // Faixas em valor fixo (formato antigo) saem antes: o anúncio só pode ter uma tabela.
  // Confere no ML depois de gravar e guarda o resultado na cópia local.
  async function gravarAtacado(conta, id, faixasTela) {
    let p = await versaoPrecos(id);
    let a = lerAtacado(p);
    if (!a.base) throw erro('Não achei o preço base do anúncio no Mercado Livre.');
    const faixas = faixasAtacado(faixasTela, a.base.preco);
    if (faixas.length) {
      // exigido pela documentação antes de gravar; quantidade incoerente o ML recusa depois
      const r = await ml('/prices-per-quantity/v1/recommendations', { method: 'POST', body: JSON.stringify({
        item_id: id, range_item_quantities: faixas.map((f) => f.quantidade),
        price: { standard_amount: a.base.preco, currency: 'BRL' } }) }).catch(() => null);
      const ruins = (r?.recommendations || []).filter((s) => s.is_incoherent_quantity).map((s) => s.quantity);
      if (ruins.length) throw erro(`O Mercado Livre não aceita atacado para ${ruins.join(', ')} unidade(s) neste anúncio (quantidade incoerente com o frete).`);
    }
    if (a.fixas.length) {
      await ml(`/items/${id}/prices/standard/quantity`, { method: 'POST',
        body: JSON.stringify({ prices: a.manter.map((pid) => ({ id: pid })) }) });
      p = await versaoPrecos(id);
      a = lerAtacado(p);
      if (a.fixas.length) throw erro('O Mercado Livre não removeu as faixas de atacado do formato antigo deste anúncio.');
    }
    // nada em percentual para tirar: não há o que gravar (só havia o formato antigo, já removido)
    if (faixas.length || a.pct.length) {
      await ml(`/items/${id}/prices/price-per-quantity`, { method: 'POST',
        headers: { 'x-version': String(p.version) }, body: JSON.stringify(corpoAtacado(faixas)) });
    }
    const novo = lerAtacado(await versaoPrecos(id));
    const res = resumoAtacado(novo);
    D.atacadoGravar(conta.ml_user_id, id, res.faixas, res.formato);
    return novo;
  }

  // ---------- atacado em massa ----------
  // Anúncios ativos da conta com SKU (10 min em memória) + o atacado de cada um (cópia local).
  let cacheAtivos = null;
  async function ativosComSku(conta) {
    if (cacheAtivos?.conta === conta.ml_user_id && Date.now() - cacheAtivos.em < 10 * 60e3) return cacheAtivos.lista;
    const { ids } = await idsDaConta(conta, 'active', null);
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const lista = (await emLotes(lotes, 4, (lote) => ml(`/items?ids=${lote.join(',')}&attributes=id,title,thumbnail,permalink,price,`
      + 'available_quantity,sold_quantity,seller_custom_field,attributes,variations').catch(() => [])))
      .flat().filter((x) => x.code === 200).map((x) => {
        const it = x.body;
        const sku = it.seller_custom_field || (it.attributes || []).find((t) => t.id === 'SELLER_SKU')?.value_name
          || (it.variations || []).map((v) => v.seller_custom_field || (v.attributes || []).find((t) => t.id === 'SELLER_SKU')?.value_name).find(Boolean) || null;
        return { id: it.id, titulo: it.title, foto: it.thumbnail, link: it.permalink, preco: it.price,
          estoque: it.available_quantity, vendidos: it.sold_quantity, sku, variacoes: (it.variations || []).length };
      });
    cacheAtivos = { conta: conta.ml_user_id, em: Date.now(), lista };
    return lista;
  }
  const SEMANA = 7 * 864e5;
  async function listaAtacado(conta, { filtro, q }) {
    const lista = await ativosComSku(conta);
    let lidos = D.atacadoDaConta(conta.ml_user_id);
    // até 300 anúncios sem leitura (ou com leitura velha) por abertura; a tela pede de novo
    const faltam = lista.filter((i) => !lidos[i.id] || Date.now() - Date.parse(lidos[i.id].lido_em) > SEMANA).slice(0, 300);
    await emLotes(faltam, 6, async (it) => {
      // show-all-prices: sem este cabeçalho o ML devolve só o preço base e o atacado não aparece (medido em 30/09/2026)
      const p = await ml(`/items/${it.id}/prices?display_version=true`, { headers: { 'show-all-prices': 'true' } }, conta.ml_user_id).catch(() => null);
      if (!p) return;
      const r = resumoAtacado(lerAtacado(p));
      D.atacadoGravar(conta.ml_user_id, it.id, r.faixas, r.formato);
    });
    if (faltam.length) lidos = D.atacadoDaConta(conta.ml_user_id);
    let itens = lista.map((i) => ({ ...i, lido: !!lidos[i.id], formato: lidos[i.id]?.formato ?? null,
      // % que faltar (faixa antiga em valor) sai do preço do anúncio
      faixas: (lidos[i.id]?.faixas || []).map((f) => ({ ...f, pct: f.pct ?? (i.preco > 0 && f.preco ? r2((1 - f.preco / i.preco) * 100) : null) })) }));
    // novo = em percentual (o formato que o ML mantém); antigo = em valor fixo (o ML desliga em 27/10/2026)
    const cont = { ativos: itens.length, novo: itens.filter((i) => i.formato === 'pct').length,
      antigo: itens.filter((i) => i.formato === 'fixo').length,
      sem: itens.filter((i) => i.lido && !i.faixas.length).length, faltam_ler: itens.filter((i) => !i.lido).length };
    if (filtro === 'novo') itens = itens.filter((i) => i.formato === 'pct');
    if (filtro === 'antigo') itens = itens.filter((i) => i.formato === 'fixo');
    if (filtro === 'com') itens = itens.filter((i) => i.lido && i.faixas.length);
    if (filtro === 'sem') itens = itens.filter((i) => i.lido && !i.faixas.length);
    const busca = String(q || '').trim().toLowerCase();
    if (busca) itens = itens.filter((i) => i.id.toLowerCase().includes(busca) || (i.titulo || '').toLowerCase().includes(busca) || (i.sku || '').toLowerCase().includes(busca));
    // quem mais vende primeiro: é onde o atacado mais importa
    itens.sort((a, b) => (b.vendidos || 0) - (a.vendidos || 0));
    return { contagem: cont, total: itens.length, itens };
  }
  // Aplica uma função em vários anúncios, um resultado por anúncio (o que o ML recusar volta com o motivo).
  const idsDoCorpo = (body, max) => {
    const ids = [...new Set(Array.isArray(body?.ids) ? body.ids : [])];
    if (!ids.length) throw erro('Escolha pelo menos um anúncio.');
    if (ids.length > max) throw erro(`No máximo ${max} anúncios por vez.`);
    ids.forEach(exigeItemId);
    return ids;
  };
  async function emMassa(conta, ids, faixasTela) {
    const resultado = await emLotes(ids, 3, async (id) => {
      try {
        const a = await gravarAtacado(conta, id, faixasTela);
        const r = resumoAtacado(a);
        const ok = faixasTela.length ? r.formato === 'pct' && r.faixas.length === faixasTela.length : !r.faixas.length;
        return { id, ok, faixas: r.faixas, formato: r.formato,
          erro: ok ? null : faixasTela.length ? 'o Mercado Livre aceitou, mas as faixas não ficaram como pedido' : 'o Mercado Livre aceitou, mas o atacado continua no anúncio' };
      } catch (e) { return { id, ok: false, erro: e.message }; }
    });
    return { pedidos: ids.length, alterados: resultado.filter((r) => r.ok).length, falhas: resultado.filter((r) => !r.ok), resultado };
  }

  const rotas = {
    // Anúncios ativos com o atacado de cada um. filtro: com | sem | (todos). q: título, MLB ou SKU.
    'GET /api/atacado': async (url) => {
      const conta = contaOuErro();
      if (url.searchParams.get('recarregar')) { cacheAtivos = null; D.atacadoEsquecer(conta.ml_user_id); }
      return listaAtacado(conta, { filtro: url.searchParams.get('filtro'), q: url.searchParams.get('q') });
    },
    // As mesmas faixas (quantidade mínima -> % de desconto) em vários anúncios.
    'POST /api/atacado/aplicar': async (_u, body) => {
      const conta = contaOuErro();
      const ids = idsDoCorpo(body, 100);
      // só percentual: o mesmo desconto vale para anúncios de preços diferentes
      const faixas = faixasAtacado((Array.isArray(body?.faixas) ? body.faixas : []).map((f) => ({ quantidade: f?.quantidade, tipo: 'pct', valor: f?.pct ?? f?.valor })), 1);
      if (!faixas.length) throw erro('Informe pelo menos uma faixa: a quantidade mínima e o desconto em %.');
      return { faixas, ...(await emMassa(conta, ids, faixas.map((f) => ({ quantidade: f.quantidade, tipo: 'pct', valor: f.pct })))) };
    },
    // Tira o preço de atacado dos anúncios escolhidos (um ou vários).
    'POST /api/atacado/remover': async (_u, body) => {
      const conta = contaOuErro();
      return emMassa(conta, idsDoCorpo(body, 100), []);
    },
  };

  // Lucro e margem do anúncio em vários preços (os dos concorrentes), com a tarifa real do ML
  // em cada um. O frete é o de hoje: cruzar R$ 79 muda o frete de verdade (aviso por preço).
  async function lucroNosPrecos(conta, id, precos) {
    const item = await ml(`/items/${id}`);
    const c = D.custosDe([id])[id];
    if (c?.custo == null) throw erro('Este anúncio está sem custo do produto: cadastre o SKU ou o custo em Produtos.');
    const empresa = (() => { try { return JSON.parse(D.configLer(`empresa:${conta.ml_user_id}`) || '{}'); } catch { return {}; } })();
    const embalagem = (c.outros ?? empresa.embalagem_padrao ?? 0) + (c.extra || 0);
    const impostoPct = D.impostoLer(conta.ml_user_id) || 0;
    const fr = await freteDoItem(conta, item, janela(60), 20).catch(() => null);
    if (fr?.por_unidade == null) throw erro('Não consegui medir o frete deste anúncio (sem vendas recentes nem estimativa do ML).');
    const base = { custo: c.custo, embalagem, frete: fr.por_unidade, impostoPct };
    const tarifas = new Map();
    const tarifaEm = async (preco) => {
      const k = Math.round(preco * 100);
      if (!tarifas.has(k)) {
        const r = await ml(`/sites/${item.site_id}/listing_prices?price=${preco}&listing_type_id=${item.listing_type_id}&category_id=${item.category_id}`);
        const x = Array.isArray(r) ? r[0] : r;
        tarifas.set(k, { pct: x?.sale_fee_details?.percentage_fee ?? 0, fixa: x?.sale_fee_details?.fixed_fee ?? 0 });
      }
      return tarifas.get(k);
    };
    const out = [];
    for (const p of precos) {
      const t = await tarifaEm(p);
      const q = quebra({ preco: p, ...base, tarifaPct: t.pct, tarifaFixa: t.fixa });
      out.push({ preco: p, lucro: q.lucro, margem: q.margem, tarifa_pct: t.pct, cruza_79: (item.price >= 79) !== (p >= 79) });
    }
    return { id, preco_atual: item.price, tem_variacoes: (item.variations || []).length > 0, precos: out };
  }

  const rotasParam = [
    { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/lucro-nos-precos$/, fn: async ([id], _b, url) => {
      const conta = contaOuErro();
      exigeItemId(id);
      const precos = [...new Set(String(url.searchParams.get('precos') || '').split(',').map((x) => Number(x)).filter((x) => x > 0 && x < 1e6))]
        .slice(0, 30).map((x) => Math.round(x * 100) / 100);
      if (!precos.length) throw erro('Informe os preços.');
      return lucroNosPrecos(conta, id, precos);
    } },
    // Preço sugerido para a margem desejada, com a tarifa real do ML na faixa de preço.
    { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/preco-margem$/, fn: async ([id], _b, url) => {
      const conta = contaOuErro();
      exigeItemId(id);
      const margemPct = Number(String(url.searchParams.get('margem') ?? '').replace(',', '.'));
      if (!Number.isFinite(margemPct) || margemPct < 0 || margemPct > 80) throw erro('Margem desejada entre 0 e 80%.');
      const item = await ml(`/items/${id}`);
      const c = D.custosDe([id])[id];
      if (c?.custo == null) throw erro('Este anúncio está sem custo do produto: cadastre o SKU ou o custo em Produtos.');
      const empresa = (() => { try { return JSON.parse(D.configLer(`empresa:${conta.ml_user_id}`) || '{}'); } catch { return {}; } })();
      const embalagem = (c.outros ?? empresa.embalagem_padrao ?? 0) + (c.extra || 0);   // embalagem + outro custo do anúncio
      const impostoPct = D.impostoLer(conta.ml_user_id) || 0;
      const fr = await freteDoItem(conta, item, janela(60), 20).catch(() => null);
      const frete = fr?.por_unidade ?? null;
      if (frete == null) throw erro('Não consegui medir o frete deste anúncio (sem vendas recentes nem estimativa do ML).');

      const tarifaEm = async (preco) => {
        const r = await ml(`/sites/${item.site_id}/listing_prices?price=${preco}`
          + `&listing_type_id=${item.listing_type_id}&category_id=${item.category_id}`);
        const x = Array.isArray(r) ? r[0] : r;
        return { pct: x?.sale_fee_details?.percentage_fee ?? 0, fixa: x?.sale_fee_details?.fixed_fee ?? 0 };
      };
      const base = { custo: c.custo, embalagem, frete, impostoPct, margemPct };
      const tAtual = await tarifaEm(item.price);
      let t = tAtual;
      let preco = precoPara({ ...base, tarifaPct: t.pct, tarifaFixa: t.fixa });
      // A tarifa (e a parte fixa abaixo de R$ 79) depende do preço: recalcula até estabilizar.
      for (let i = 0; i < 5 && preco; i++) {
        const t2 = await tarifaEm(preco);
        const p2 = precoPara({ ...base, tarifaPct: t2.pct, tarifaFixa: t2.fixa });
        t = t2;
        if (p2 == null || Math.abs(p2 - preco) < 0.01) { preco = p2; break; }
        preco = p2;
      }
      if (preco == null) throw erro('Com essa margem, tarifa e imposto passam de 100% do preço: não existe preço possível.');
      const atual = quebra({ preco: item.price, ...base, tarifaPct: tAtual.pct, tarifaFixa: tAtual.fixa });
      const novo = quebra({ preco, ...base, tarifaPct: t.pct, tarifaFixa: t.fixa });
      const cruza79 = (item.price >= 79) !== (preco >= 79);
      return {
        id, margem_desejada: margemPct, preco_atual: item.price, preco_sugerido: preco,
        atual, novo, tarifa_pct: t.pct, frete_fonte: fr.fonte, frete_amostra: fr.amostra,
        tem_variacoes: (item.variations || []).length > 0,
        aviso: cruza79 ? 'O novo preço cruza R$ 79: o frete pago por você muda nessa faixa. Confira o resultado depois das próximas vendas.' : null,
      };
    } },

    // GTIN do anúncio (atributo GTIN), gravado no Mercado Livre.
    { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)\/gtin$/, fn: async ([id], body) => {
      contaOuErro();
      exigeItemId(id);
      const gtin = String(body?.gtin ?? '').replace(/\s/g, '');
      if (!gtinValido(gtin)) throw erro('GTIN inválido: use o código de barras de 8, 12, 13 ou 14 dígitos (o último é o verificador).');
      await ml(`/items/${id}`, { method: 'PUT', body: JSON.stringify({ attributes: [{ id: 'GTIN', value_name: gtin }] }) });
      return { id, gtin };
    } },

    // Atacado atual do anúncio + as sugestões do ML para as mesmas quantidades.
    { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/atacado$/, fn: async ([id]) => {
      contaOuErro();
      exigeItemId(id);
      const a = lerAtacado(await versaoPrecos(id));
      const qtds = (a.pct.length ? a.pct : a.fixas).map((f) => f.quantidade);
      let sugestoes = null;
      if (a.base) {
        try {
          const r = await ml('/prices-per-quantity/v1/recommendations', { method: 'POST', body: JSON.stringify({
            item_id: id, range_item_quantities: qtds.length ? qtds : [2, 5, 10],
            price: { standard_amount: a.base.preco, currency: 'BRL' } }) });
          sugestoes = (r?.recommendations || []).map((s) => ({ quantidade: s.quantity, preco: s.amount,
            pct: r2(s.discount?.percentage ?? 0), incoerente: !!s.is_incoherent_quantity,
            frete_original: s.shipping?.original_cost ?? null, frete: s.shipping?.cost ?? null }));
        } catch { sugestoes = null; }
      }
      return { ...a, sugestoes };
    } },

    // Grava a tabela de atacado em percentual. Faixas em valor fixo (formato antigo) saem antes:
    // o anúncio só pode ter uma tabela de atacado.
    { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)\/atacado$/, fn: async ([id], body) => {
      const conta = contaOuErro();
      exigeItemId(id);
      return gravarAtacado(conta, id, body?.faixas);
    } },
  ];

  return { rotas, rotasParam };
}

module.exports = { criar, precoPara, quebra, gtinValido, faixasAtacado, corpoAtacado, lerAtacado, resumoAtacado };
