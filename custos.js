'use strict';
// Custos do vendedor: tabela de produtos (custo por componente), custo de cada anúncio pelo
// SKU, dados da empresa (impostos) e a tela Vendas (lucro e margem venda a venda).
//
// SKU do anúncio numa conta real (medido em 28/09/2026 nos pedidos): "KIT-407.408",
// "KIT-830.079.816.781.671.678", às vezes com ponto no fim ("KIT-795.713.739.802.698.").
// Cada número é um produto da tabela (407 = DQ-407, 079 = BP-079); o custo do anúncio é
// a soma dos componentes. Número repetido conta duas vezes (kit com duas peças iguais).

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// "R$ 1.234,56" -> 1234.56; "R$ -", vazio -> null.
function dinheiro(txt) {
  const s = String(txt ?? '').replace(/R\$/i, '').replace(/\s/g, '');
  if (!s || s === '-' || s === '—') return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Tabela colada da planilha (TAB, ";" ou ","). Precisa das colunas SKU e Custo; Produto,
// Situação e Fornecedor entram se existirem. A chave é o número no fim do SKU (DQ-407 -> 407).
function lerCatalogo(texto) {
  const linhas = String(texto || '').split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) throw erro('Cole a tabela com o cabeçalho (SKU, Custo, Produto…) e pelo menos uma linha.');
  const sep = linhas[0].includes('\t') ? '\t' : linhas[0].includes(';') ? ';' : ',';
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const cab = linhas[0].split(sep).map(norm);
  const col = (...nomes) => cab.findIndex((c) => nomes.includes(c));
  const iSku = col('sku', 'codigo'), iCusto = col('custo', 'custo unitario', 'preco de custo');
  if (iSku < 0 || iCusto < 0) throw erro('Não achei as colunas "SKU" e "Custo" no cabeçalho.');
  const iNome = col('produto', 'nome', 'descricao'), iSit = col('situacao'), iForn = col('fornecedor');
  const out = [], ignorados = [];
  for (const l of linhas.slice(1)) {
    const c = l.split(sep);
    const sku = String(c[iSku] || '').trim();
    const m = /(\d+)\s*$/.exec(sku);
    if (!m || sku.startsWith('*')) { if (sku) ignorados.push(sku); continue; }
    out.push({
      numero: Number(m[1]), sku,
      nome: iNome >= 0 ? String(c[iNome] || '').trim() || null : null,
      custo: dinheiro(c[iCusto]),
      situacao: iSit >= 0 ? String(c[iSit] || '').trim() || null : null,
      fornecedor: iForn >= 0 ? String(c[iForn] || '').trim() || null : null,
    });
  }
  if (!out.length) throw erro('Nenhuma linha com SKU válido (ex.: DQ-407).');
  return { produtos: out, ignorados };
}

// Números dos componentes de um SKU de anúncio. "KIT-407.408" -> [407, 408];
// "DQ-407" (um produto só) -> [407]. Sem número -> []. Hífen também separa: a Amazon usa
// "KIT-795-615-746-698" para os produtos 795 + 615 + 746 + 698 (SKU da Amazon não se troca).
function componentes(sku) {
  const s = String(sku || '').trim();
  if (!s) return [];
  const resto = s.includes('-') ? s.slice(s.indexOf('-') + 1) : s;
  return resto.split(/[-.\s+/]+/).filter((p) => /^\d+$/.test(p)).map(Number);
}

// Custo de um SKU pela tabela. `porNumero` = Map(numero -> produto). Componente fora da
// tabela ou sem custo deixa o total null e aparece em `faltando`.
function custoDoSku(sku, porNumero) {
  const nums = componentes(sku);
  if (!nums.length) return { custo: null, componentes: [], faltando: [], motivo: sku ? 'sku_sem_numero' : 'sem_sku' };
  const comps = nums.map((n) => {
    const p = porNumero.get(n);
    return { numero: n, sku: p?.sku || null, nome: p?.nome || null, custo: p?.custo ?? null };
  });
  const faltando = comps.filter((c) => c.custo == null).map((c) => c.sku || String(c.numero).padStart(3, '0'));
  const custo = faltando.length ? null : Math.round(comps.reduce((s, c) => s + c.custo, 0) * 100) / 100;
  return { custo, componentes: comps, faltando, motivo: faltando.length ? 'componente_sem_custo' : null };
}

// Troca UM produto dentro do SKU de um anúncio, sem mexer no resto: o fornecedor mudou e o
// DD-795 virou DD-854 -> "KIT-795.713.739." vira "KIT-854.713.739.". Só troca o número
// inteiro (795 não casa com 1795 nem com 79). Função pura: testada.
function trocarComponente(sku, de, para) {
  const s = String(sku || '');
  const i = s.indexOf('-');
  const prefixo = i >= 0 ? s.slice(0, i + 1) : '';
  const resto = i >= 0 ? s.slice(i + 1) : s;
  const novo = String(para).padStart(3, '0');
  return prefixo + resto.replace(/(^|[-.\s+/])(\d+)(?=$|[-.\s+/])/g, (m, sep, n) => (Number(n) === de ? sep + novo : m));
}

// SKUs de um anúncio: o do próprio anúncio e o de cada variação.
function skusDoAnuncio(it) {
  const doAttr = (attrs) => (attrs || []).find((a) => a.id === 'SELLER_SKU')?.value_name || null;
  const base = it.seller_custom_field || doAttr(it.attributes);
  const vars = (it.variations || []).map((v) => ({ id: v.id, sku: v.seller_custom_field || doAttr(v.attributes) || null,
    nome: (v.attribute_combinations || []).map((a) => a.value_name).filter(Boolean).join(' / ') || null }));
  return { base, variacoes: vars };
}

// Dados da empresa: impostos em % do faturamento, somados no lucro.
function lerEmpresa(txt) {
  let e = {};
  try { e = JSON.parse(txt || '{}') || {}; } catch {}
  return {
    razao_social: e.razao_social || '', cnpj: e.cnpj || '', regime: e.regime || '',
    impostos: Array.isArray(e.impostos) ? e.impostos : [],
    embalagem_padrao: e.embalagem_padrao ?? null,
  };
}
function validarEmpresa(b) {
  const texto = (v, max) => String(v ?? '').trim().slice(0, max);
  // linha totalmente em branco (sem nome e sem %) é descartada; meio preenchida é erro
  const impostos = (Array.isArray(b.impostos) ? b.impostos : [])
    .filter((i) => texto(i.nome, 60) || String(i.pct ?? '').trim())
    .map((i) => ({ nome: texto(i.nome, 60), pct: Number(String(i.pct ?? '').replace(',', '.')) }));
  for (const i of impostos) {
    if (!i.nome) throw erro('Dê um nome a cada imposto (ex.: Simples Nacional, DIFAL).');
    if (!Number.isFinite(i.pct) || i.pct < 0 || i.pct > 100) throw erro(`Percentual inválido em "${i.nome}".`);
    i.pct = Math.round(i.pct * 100) / 100;
  }
  let emb = b.embalagem_padrao;
  emb = emb === '' || emb == null ? null : Number(String(emb).replace(',', '.'));
  if (emb != null && (!Number.isFinite(emb) || emb < 0 || emb > 1e5)) throw erro('Embalagem padrão inválida.');
  return { razao_social: texto(b.razao_social, 120), cnpj: texto(b.cnpj, 20), regime: texto(b.regime, 40),
    impostos, embalagem_padrao: emb };
}
const impostoTotal = (empresa) => Math.round(empresa.impostos.reduce((s, i) => s + (i.pct || 0), 0) * 100) / 100;

// Soma o resumo (hoje e o período) de várias contas. A margem é o lucro sobre o faturamento
// que TEM custo cadastrado (faturamento × cobertura de cada conta), como em cada conta.
// Função pura: testada.
// Os produtos (SKU) que mais faturaram juntando as contas: o mesmo kit vendido em duas
// contas vira uma linha só, com a parte de cada conta. O que junta são os NÚMEROS dos
// produtos, não o texto do SKU — medido em 30/09/2026: uma conta usa "KIT-769.790.816" e a
// outra "769.790.816." para o mesmo kit. Venda sem SKU agrupa pelo anúncio.
// Função pura: testada.
function topPorSku(vendas, limite = 30) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const m = new Map();
  for (const v of vendas) {
    const nums = componentes(v.sku);
    const chave = nums.length ? [...nums].sort((a, b) => a - b).join('.') : (v.sku || v.item_id);
    const x = m.get(chave) || { sku: v.sku || null, skus: [], titulo: v.titulo || null, foto: v.foto || null, unidades: 0, pedidos: 0,
      faturamento: 0, lucro: 0, sem_custo: false, por_conta: {} };
    if (v.sku && !x.skus.includes(v.sku)) x.skus.push(v.sku);
    x.titulo ||= v.titulo || null; x.foto ||= v.foto || null;
    x.unidades += v.quantidade || 0; x.pedidos += 1; x.faturamento += v.faturamento || 0;
    if (v.lucro == null) x.sem_custo = true; else x.lucro += v.lucro;
    const pc = x.por_conta[v.conta] || { unidades: 0, faturamento: 0 };
    pc.unidades += v.quantidade || 0; pc.faturamento += v.faturamento || 0;
    x.por_conta[v.conta] = pc;
    m.set(chave, x);
  }
  return [...m.values()].sort((a, b) => b.faturamento - a.faturamento).slice(0, limite).map((x) => ({ ...x,
    faturamento: r2(x.faturamento), lucro: x.sem_custo ? null : r2(x.lucro),
    margem: !x.sem_custo && x.faturamento > 0 ? x.lucro / x.faturamento : null,
    por_conta: Object.fromEntries(Object.entries(x.por_conta).map(([k, p]) => [k, { unidades: p.unidades, faturamento: r2(p.faturamento) }])) }));
}

function somarContas(linhas) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const de = (k) => {
    const t = { pedidos: 0, unidades: 0, faturamento: 0, tarifa: 0, frete: 0, produto: 0, embalagem: 0, imposto: 0, lucro: 0, cancelados: 0 };
    let comCusto = 0;
    for (const l of linhas) {
      const r = l[k] || {};
      for (const c of Object.keys(t)) t[c] += r[c] || 0;
      comCusto += (r.faturamento || 0) * (r.cobertura || 0);
    }
    for (const c of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto', 'lucro']) t[c] = r2(t[c]);
    return { ...t, margem: comCusto > 0 ? t.lucro / comCusto : null, cobertura: t.faturamento > 0 ? comCusto / t.faturamento : null };
  };
  return { contas: linhas.length, hoje: de('hoje'), periodo: de('periodo') };
}

// Uma linha de venda com todos os custos. `ctx` traz o custo do SKU, a embalagem do
// anúncio e o imposto. Frete do envio é rateado pelo valor quando o pacote tem vários itens.
function contaDaLinha(l, ctx) {
  const fat = l.quantidade * l.preco_unit;
  const tarifa = l.quantidade * (l.tarifa_unit || 0);
  const frete = l.frete_envio == null ? null
    : (l.total_envio > 0 ? l.frete_envio * (fat / l.total_envio) : l.frete_envio);
  const produto = ctx.custo_unit == null ? null : ctx.custo_unit * l.quantidade;
  const embalagem = (ctx.embalagem_unit || 0) * l.quantidade;
  const imposto = (ctx.imposto_pct || 0) / 100 * fat;
  const falta = [];
  if (produto == null) falta.push('custo');
  if (frete == null) falta.push('frete');
  const lucro = falta.length ? null : fat - tarifa - frete - produto - embalagem - imposto;
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return { faturamento: r2(fat), tarifa: r2(tarifa), frete: r2(frete), produto: r2(produto), embalagem: r2(embalagem),
    imposto: r2(imposto), lucro: r2(lucro), margem: lucro != null && fat > 0 ? lucro / fat : null, falta };
}

function criar({ ml, emLotes, contaOuErro, exigeItemId, sincronizarVendas, janela, baixarPedidos, idsDaConta, D }) {
  const empresaDe = (conta) => lerEmpresa(D.configLer(`empresa:${conta.ml_user_id}`));
  const catalogoMapa = () => new Map(D.catalogoListar().map((p) => [p.numero, p]));

  // Anúncios da conta com SKU (inclusive das variações). Cache curto: a tela de custos abre
  // e fecha várias vezes seguidas.
  let cacheAnuncios = null;
  async function anunciosComSku(conta) {
    if (cacheAnuncios && cacheAnuncios.conta === conta.ml_user_id && Date.now() - cacheAnuncios.em < 5 * 60e3) {
      return cacheAnuncios.lista;
    }
    const { ids } = await idsDaConta(conta, null, null);
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const lista = (await emLotes(lotes, 4, (lote) => ml(`/items?ids=${lote.join(',')}&attributes=id,title,`
      + 'thumbnail,permalink,status,price,available_quantity,seller_custom_field,attributes,variations')))
      .flat().filter((x) => x.code === 200).map((x) => x.body);
    cacheAnuncios = { conta: conta.ml_user_id, em: Date.now(), lista };
    return lista;
  }

  // Custo de cada anúncio pelo SKU. Com variações de custos diferentes, o custo do anúncio
  // (usado na tela Meus anúncios) é a média; a tela Vendas usa o SKU exato de cada venda.
  function custoDoAnuncio(it, mapa) {
    const { base, variacoes } = skusDoAnuncio(it);
    const skus = variacoes.length ? variacoes.map((v) => v.sku || base) : [base];
    const calc = skus.map((s) => ({ sku: s, ...custoDoSku(s, mapa) }));
    const ok = calc.filter((c) => c.custo != null);
    const custo = ok.length === calc.length && ok.length
      ? Math.round(ok.reduce((s, c) => s + c.custo, 0) / ok.length * 100) / 100 : null;
    const variaveis = new Set(ok.map((c) => c.custo)).size > 1;
    return { skus: calc, custo, variaveis,
      faltando: [...new Set(calc.flatMap((c) => c.faltando))],
      sem_sku: calc.some((c) => c.motivo === 'sem_sku' || c.motivo === 'sku_sem_numero') };
  }

  // Aplica a tabela aos anúncios: grava custos (origem 'sku') e devolve a lista com alertas.
  async function aplicarCatalogo(conta) {
    const mapa = catalogoMapa();
    const anuncios = await anunciosComSku(conta);
    const custos = D.custosDe(anuncios.map((a) => a.id));
    const empresa = empresaDe(conta);
    return anuncios.map((it) => {
      const c = custoDoAnuncio(it, mapa);
      const atual = custos[it.id];
      if (c.custo != null && atual?.origem !== 'manual') D.custoAutoGravar(conta.ml_user_id, it.id, c.custo);
      const manual = atual?.origem === 'manual';
      return {
        id: it.id, titulo: it.title, foto: it.thumbnail, status: it.status, preco: it.price, link: it.permalink,
        skus: c.skus.map((s) => ({ sku: s.sku, custo: s.custo, faltando: s.faltando,
          componentes: s.componentes })),
        custo_sku: c.custo, custo_variavel: c.variaveis,
        custo: manual ? atual.custo : c.custo, origem: manual ? 'manual' : (c.custo != null ? 'sku' : null),
        embalagem: atual?.outros ?? null, outro_custo: atual?.extra ?? null, embalagem_padrao: empresa.embalagem_padrao,
        alerta: manual || c.custo != null ? null
          : c.sem_sku ? 'Anúncio sem SKU (ou SKU sem os números dos produtos)'
            : `Sem custo na tabela: ${c.faltando.join(', ')}`,
      };
    });
  }

  const DIAS_OK = [1, 7, 15, 30, 60, 90];

  // Composição de um anúncio (de /items): o SKU de cada variação e os produtos que o formam.
  function composicao(it, mapa = catalogoMapa()) {
    const { base, variacoes } = skusDoAnuncio(it);
    const linhas = variacoes.length
      ? variacoes.map((v) => ({ variacao_id: v.id, variacao: v.nome, sku: v.sku || base || null,
        estoque: (it.variations || []).find((x) => x.id === v.id)?.available_quantity ?? null }))
      : [{ variacao_id: null, variacao: null, sku: base || null, estoque: it.available_quantity ?? null }];
    return linhas.map((l) => {
      const c = custoDoSku(l.sku, mapa);
      return { ...l, custo: c.custo, faltando: c.faltando,
        produtos: c.componentes.map((p) => ({ numero: p.numero, sku: p.sku, nome: p.nome, custo: p.custo })) };
    });
  }

  // Anúncios que têm o produto no kit. `produto` = "DQ-407", "407" ou "dq407".
  async function idsComProduto(conta, produto) {
    const m = /(\d+)\s*$/.exec(String(produto || '').trim());
    if (!m) throw erro('Produto inválido: use o SKU (ex.: DQ-407) ou o número (407).');
    const n = Number(m[1]);
    const lista = await anunciosComSku(conta);
    return lista.filter((it) => {
      const { base, variacoes } = skusDoAnuncio(it);
      return [base, ...variacoes.map((v) => v.sku)].some((s) => componentes(s).includes(n));
    }).map((it) => it.id);
  }

  const rotas = {
    // ?conta=amazon: os dados da empresa que valem para a Amazon (amazon.js#empresaAmazon).
    // Enquanto não forem salvos, a tela mostra os da conta do ML usada até então.
    'GET /api/empresa': async (url) => {
      if (url?.searchParams?.get('conta') === 'amazon') {
        const proprio = D.configLer('empresa:amazon');
        const reserva = Number(D.configLer('amazon_empresa_conta')) || D.contasListar()[0]?.ml_user_id;
        const e = lerEmpresa(proprio || (reserva ? D.configLer(`empresa:${reserva}`) : null));
        return { ...e, imposto_total: impostoTotal(e), catalogo: D.catalogoResumo(), amazon: true, salvo: !!proprio };
      }
      const conta = contaOuErro();
      const e = empresaDe(conta);
      return { ...e, imposto_total: impostoTotal(e), catalogo: D.catalogoResumo() };
    },

    'PUT /api/empresa': async (url, body) => {
      if (url?.searchParams?.get('conta') === 'amazon') {
        const e = validarEmpresa(body || {});
        D.configGravar('empresa:amazon', JSON.stringify(e));
        return { ...e, imposto_total: impostoTotal(e), amazon: true };
      }
      const conta = contaOuErro();
      const e = validarEmpresa(body || {});
      D.configGravar(`empresa:${conta.ml_user_id}`, JSON.stringify(e));
      D.impostoGravar(conta.ml_user_id, impostoTotal(e));   // a tela Meus anúncios lê daqui
      return { ...e, imposto_total: impostoTotal(e) };
    },

    'GET /api/produtos-custo': async () => {
      contaOuErro();
      return { produtos: D.catalogoListar(), resumo: D.catalogoResumo() };
    },

    // Importa a tabela colada da planilha e recalcula o custo dos anúncios.
    'POST /api/produtos-custo': async (_u, body) => {
      const conta = contaOuErro();
      const { produtos, ignorados } = lerCatalogo(body?.texto);
      D.catalogoGravar(produtos);
      cacheAnuncios = null;
      const anuncios = await aplicarCatalogo(conta);
      return { importados: produtos.length, sem_custo: produtos.filter((p) => p.custo == null).length,
        ignorados: ignorados.length, anuncios_com_custo: anuncios.filter((a) => a.custo != null).length,
        anuncios_sem_custo: anuncios.filter((a) => a.alerta).length };
    },

    // Tela Produtos: a tabela com quantos anúncios usam cada produto e o estoque deles no ML.
    'GET /api/produtos': async (url) => {
      const conta = contaOuErro();
      if (url.searchParams.get('recarregar')) cacheAnuncios = null;
      const produtos = D.catalogoListar();
      let uso = new Map();
      try {
        const lista = await anunciosComSku(conta);
        for (const it of lista) {
          const { base, variacoes } = skusDoAnuncio(it);
          const nums = new Set([base, ...variacoes.map((v) => v.sku)].flatMap((s) => componentes(s)));
          for (const n of nums) {
            const u = uso.get(n) || { anuncios: 0, ativos: 0, estoque: 0 };
            u.anuncios++;
            if (it.status === 'active') { u.ativos++; u.estoque += it.available_quantity || 0; }
            uso.set(n, u);
          }
        }
      } catch { uso = new Map(); }   // sem ML, a tabela ainda abre (sem a contagem)
      return {
        resumo: D.catalogoResumo(),
        produtos: produtos.map((p) => ({ ...p, uso: uso.get(p.numero) || { anuncios: 0, ativos: 0, estoque: 0 } })),
      };
    },

    // Produto novo na tabela (ou o mesmo número de novo, que substitui).
    'POST /api/produtos': async (_u, body) => {
      const conta = contaOuErro();
      const p = produtoDoCorpo(body || {});
      D.catalogoGravar([p]);
      cacheAnuncios = null;
      await aplicarCatalogo(conta).catch(() => null);
      return p;
    },

    'GET /api/custos-anuncios': async (url) => {
      const conta = contaOuErro();
      if (url.searchParams.get('recarregar')) cacheAnuncios = null;
      const anuncios = await aplicarCatalogo(conta);
      return { anuncios, sem_custo: anuncios.filter((a) => a.alerta).length, catalogo: D.catalogoResumo() };
    },

    // Todas as vendas do período com frete, tarifa, imposto, custo do produto, embalagem e margem.
    'GET /api/vendas': async (url) => vendasDaConta(contaOuErro(), Number(url.searchParams.get('dias')) || 30),

    // Dashboard de todas as contas conectadas (tela "Todas as contas"): hoje e o período de
    // cada uma, a soma e os produtos mais vendidos juntando as contas.
    'GET /api/contas/resumo': async (url) => {
      const d = Number(url?.searchParams.get('dias')) || 30;
      return resumoDasContas([7, 15, 30, 60, 90].includes(d) ? d : 30);
    },
  };

  // As vendas de UMA conta (a ativa na tela Vendas; cada conta conectada no resumo geral).
  // `titulos: false` pula a busca de título e foto dos anúncios, que o resumo não usa.
  async function vendasDaConta(conta, pedido, { titulos = true } = {}) {
    {
      const dias = DIAS_OK.includes(pedido) ? pedido : 30;
      await sincronizarVendas(conta, Math.max(dias, 7));
      const j = dias === 1
        ? { de: new Date(Date.parse(new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10) + 'T03:00:00Z')).toISOString(),
          ate: new Date(Date.now() + 60e3).toISOString() }
        : { ...janela(dias), ate: new Date(Date.now() + 60e3).toISOString() };

      // Vendas baixadas antes de o painel guardar o SKU: baixa de novo a janela (uma vez só).
      if (D.vendasSemSku(conta.ml_user_id, j.de, j.ate) > 0) {
        const pedidos = await baixarPedidos(conta.ml_user_id, 'date_created', new Date(j.de), new Date(j.ate));
        D.vendasGravar(pedidos.flatMap((o) => (o.order_items || []).filter((oi) => oi.item?.id).map((oi) => ({
          order_id: o.id, item_id: oi.item.id, variacao: oi.item.variation_id || 0, ml_user_id: conta.ml_user_id,
          data: new Date(o.date_created).toISOString(), status: o.status, quantidade: oi.quantity || 0,
          preco_unit: oi.unit_price ?? 0, tarifa_unit: oi.sale_fee ?? null, envio_id: o.shipping?.id ?? null,
          sku: oi.item.seller_sku || oi.item.seller_custom_field || '', origem: oi.stock?.node_id || '',
        }))));
      }

      // Frete: até 300 envios novos por abertura; o resto vem nas próximas (fica guardado).
      const faltam = D.enviosSemFreteConta(conta.ml_user_id, j.de, j.ate, 300);
      await emLotes(faltam, 6, async (envio) => {
        const c = await ml(`/shipments/${envio}/costs`, {}, conta.ml_user_id).catch(() => null);
        const s = (c?.senders || []).find((x) => Number(x.user_id) === Number(conta.ml_user_id));
        if (s && Number.isFinite(s.cost)) D.freteGravar(conta.ml_user_id, envio, s.cost);
        else if (c) D.freteGravar(conta.ml_user_id, envio, 0);   // envio sem custo para o vendedor
      });
      const restam = D.enviosSemFreteConta(conta.ml_user_id, j.de, j.ate, 1000).length;

      const linhas = D.vendasLinhas(conta.ml_user_id, j.de, j.ate);
      const mapa = catalogoMapa();
      const ids = [...new Set(linhas.map((l) => l.item_id))];
      const custos = D.custosDe(ids);
      const empresa = empresaDe(conta);
      const impostoPct = impostoTotal(empresa) || D.impostoLer(conta.ml_user_id) || 0;
      const info = {};
      for (let i = 0; titulos && i < ids.length; i += 20) {
        try {
          const r = await ml(`/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,thumbnail,permalink`);
          for (const x of r) if (x.code === 200) info[x.body.id] = x.body;
        } catch {}
      }

      const vendas = [], semCusto = new Map();
      const tot = { pedidos: new Set(), unidades: 0, faturamento: 0, tarifa: 0, frete: 0, produto: 0,
        embalagem: 0, imposto: 0, lucro: 0, com_lucro_fat: 0, cancelados: 0 };
      for (const l of linhas) {
        const valida = ['paid', 'partially_refunded'].includes(l.status);
        const cSku = custoDoSku(l.sku, mapa);
        const cItem = custos[l.item_id];
        const custoUnit = cItem?.origem === 'manual' ? cItem.custo : (cSku.custo ?? cItem?.custo ?? null);
        const emb = (cItem?.outros ?? empresa.embalagem_padrao ?? 0) + (cItem?.extra || 0);   // embalagem + outro custo do anúncio
        const conta_ = contaDaLinha(l, { custo_unit: custoUnit, embalagem_unit: emb, imposto_pct: impostoPct });
        if (valida && custoUnit == null) {
          const k = l.item_id;
          const s = semCusto.get(k) || { item_id: k, titulo: info[k]?.title || null, sku: l.sku || null,
            faltando: cSku.faltando, vendas: 0 };
          s.vendas++; semCusto.set(k, s);
        }
        vendas.push({
          pedido: l.order_id, data: l.data, status: l.status, valida, item_id: l.item_id,
          titulo: info[l.item_id]?.title || null, foto: info[l.item_id]?.thumbnail || null,
          sku: l.sku || null, quantidade: l.quantidade, preco_unit: l.preco_unit,
          full: !!l.origem && !/^BRP\d+$/.test(l.origem),   // saiu do armazém do ML
          componentes: cSku.componentes.map((c) => ({ sku: c.sku || String(c.numero), custo: c.custo })),
          custo_unit: custoUnit, embalagem_unit: emb, ...conta_,
          link: `https://www.mercadolivre.com.br/vendas/${l.order_id}/detalhe`,
        });
        if (!valida) { tot.cancelados++; continue; }
        tot.pedidos.add(l.order_id);
        tot.unidades += l.quantidade;
        for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto']) tot[k] += conta_[k] || 0;
        if (conta_.lucro != null) { tot.lucro += conta_.lucro; tot.com_lucro_fat += conta_.faturamento; }
      }
      const r2 = (v) => Math.round(v * 100) / 100;
      return {
        dias, de: j.de, ate: j.ate, imposto_pct: impostoPct, fretes_pendentes: restam,
        resumo: {
          pedidos: tot.pedidos.size, unidades: tot.unidades, faturamento: r2(tot.faturamento),
          tarifa: r2(tot.tarifa), frete: r2(tot.frete), produto: r2(tot.produto), embalagem: r2(tot.embalagem),
          imposto: r2(tot.imposto), lucro: r2(tot.lucro),
          // margem só sobre as vendas que têm custo: as sem custo entram no alerta, não no zero
          margem: tot.com_lucro_fat > 0 ? tot.lucro / tot.com_lucro_fat : null,
          cobertura: tot.faturamento > 0 ? tot.com_lucro_fat / tot.faturamento : null,
          cancelados: tot.cancelados,
        },
        sem_custo: [...semCusto.values()].sort((a, b) => b.vendas - a.vendas),
        vendas,
      };
    }
  }

  // Uma conta de cada vez (o ML limita chamadas por conta, e a primeira abertura de uma conta
  // nova baixa os pedidos dela). Conta que falhar — token vencido, sem permissão — aparece
  // com o erro, sem derrubar as outras.
  async function resumoDasContas(dias = 30) {
    const linhas = [], vendidas = [];
    for (const c of D.contasListar()) {
      const conta = D.contaObter(c.ml_user_id);
      const base = { ml_user_id: c.ml_user_id, nickname: c.nickname };
      try {
        const hoje = await vendasDaConta(conta, 1, { titulos: false });
        const per = await vendasDaConta(conta, dias);
        linhas.push({ ...base, hoje: hoje.resumo, periodo: per.resumo, sem_custo: per.sem_custo.length,
          fretes_pendentes: per.fretes_pendentes,
          dias: D.vendasPorDia(c.ml_user_id, per.de, per.ate).map((d) => ({ dia: d.dia, faturamento: d.faturamento, pedidos: d.pedidos })) });
        for (const v of per.vendas) if (v.valida) vendidas.push({ ...v, conta: c.ml_user_id });
      } catch (e) { linhas.push({ ...base, erro: e.message }); }
    }
    return { dias, contas: linhas, total: somarContas(linhas.filter((l) => !l.erro)), produtos: topPorSku(vendidas, 30) };
  }

  // Um produto da tabela a partir do formulário. O número sai do SKU (DQ-407 -> 407).
  function produtoDoCorpo(b, numeroFixo = null) {
    const sku = String(b.sku ?? '').trim().toUpperCase();
    const m = /^[A-Z*]{1,4}-(\d+)$/.exec(sku);
    if (!m) throw erro('SKU do produto no formato PREFIXO-NÚMERO, ex.: DQ-407.');
    const numero = Number(m[1]);
    if (numeroFixo != null && numero !== numeroFixo) throw erro('O número do SKU não pode mudar (ele é a chave do produto).');
    const c = b.custo === '' || b.custo == null ? null : Number(String(b.custo).replace(',', '.'));
    if (c != null && (!Number.isFinite(c) || c < 0 || c > 1e6)) throw erro('Custo inválido.');
    return { numero, sku, nome: String(b.nome ?? '').trim().slice(0, 120) || null,
      custo: c == null ? null : Math.round(c * 100) / 100,
      situacao: String(b.situacao ?? '').trim().slice(0, 30) || null,
      fornecedor: String(b.fornecedor ?? '').trim().slice(0, 60) || null };
  }

  const numeroDoProduto = (txt) => {
    const m = /(\d+)\s*$/.exec(String(txt ?? '').trim());
    if (!m) throw erro('Produto inválido: use o SKU (ex.: DD-854) ou o número (854).');
    return Number(m[1]);
  };

  const rotasParam = [
    // Anúncios que têm o produto no SKU (para escolher em quais trocar o produto).
    { m: 'GET', re: /^\/api\/produtos\/(\d+)\/anuncios$/, fn: async ([n], _b, url) => {
      const conta = contaOuErro();
      const numero = Number(n);
      if (url?.searchParams.get('recarregar')) cacheAnuncios = null;
      const lista = await anunciosComSku(conta);
      const anuncios = [];
      for (const it of lista) {
        const { base, variacoes } = skusDoAnuncio(it);
        const skus = (variacoes.length ? variacoes.map((v) => ({ variacao: v.nome, sku: v.sku || base })) : [{ variacao: null, sku: base }])
          .filter((s) => componentes(s.sku).includes(numero));
        if (!skus.length) continue;
        anuncios.push({ id: it.id, titulo: it.title, foto: it.thumbnail, link: it.permalink, status: it.status,
          estoque: it.available_quantity ?? null, skus });
      }
      const ordem = { active: 0, paused: 1, under_review: 2 };
      anuncios.sort((a, b) => (ordem[a.status] ?? 3) - (ordem[b.status] ?? 3) || String(a.titulo).localeCompare(String(b.titulo)));
      return { produto: D.catalogoListar().find((p) => p.numero === numero) || { numero }, total: anuncios.length, anuncios };
    } },

    // Trocar um produto por outro no SKU dos anúncios escolhidos (mudou o fornecedor: 795 -> 854).
    // Muda no Mercado Livre (SELLER_SKU do anúncio e de cada variação que tem o produto) e
    // recalcula o custo. Variação fora do PUT é apagada pelo ML: vão todas, pelo id.
    { m: 'POST', re: /^\/api\/produtos\/(\d+)\/trocar-sku$/, fn: async ([n], body) => {
      const conta = contaOuErro();
      const de = Number(n);
      const para = numeroDoProduto(body?.novo);
      if (para === de) throw erro('O produto novo é igual ao atual.');
      const ids = [...new Set(Array.isArray(body?.ids) ? body.ids : [])];
      if (!ids.length) throw erro('Escolha pelo menos um anúncio.');
      if (ids.length > 200) throw erro('No máximo 200 anúncios por vez.');
      ids.forEach(exigeItemId);
      const attrSku = (attrs) => (attrs || []).find((a) => a.id === 'SELLER_SKU')?.value_name || null;
      const tem = (sku) => componentes(sku).includes(de);
      const mapa = catalogoMapa();
      const resultado = await emLotes(ids, 3, async (id) => {
        try {
          const it = await ml(`/items/${id}?attributes=id,variations,attributes,seller_custom_field,status`);
          const corpo = {}, trocas = [];
          // SKU no anúncio: atributo SELLER_SKU; conta antiga pode ter no seller_custom_field
          const baseAttr = attrSku(it.attributes);
          if (tem(baseAttr)) { corpo.attributes = [{ id: 'SELLER_SKU', value_name: trocarComponente(baseAttr, de, para) }]; trocas.push({ antes: baseAttr, depois: trocarComponente(baseAttr, de, para) }); }
          if (tem(it.seller_custom_field)) {
            corpo.seller_custom_field = trocarComponente(it.seller_custom_field, de, para);
            if (!trocas.length) trocas.push({ antes: it.seller_custom_field, depois: corpo.seller_custom_field });
          }
          const vars = it.variations || [];
          if (vars.some((v) => tem(attrSku(v.attributes)) || tem(v.seller_custom_field))) {
            corpo.variations = vars.map((v) => {
              const a = attrSku(v.attributes), out = { id: v.id };
              if (tem(a)) { out.attributes = [{ id: 'SELLER_SKU', value_name: trocarComponente(a, de, para) }]; trocas.push({ antes: a, depois: trocarComponente(a, de, para) }); }
              if (tem(v.seller_custom_field)) {
                out.seller_custom_field = trocarComponente(v.seller_custom_field, de, para);
                if (!tem(a)) trocas.push({ antes: v.seller_custom_field, depois: out.seller_custom_field });
              }
              return out;
            });
          }
          if (!trocas.length) return { id, ok: false, erro: 'o SKU deste anúncio não tem mais esse produto' };
          await ml(`/items/${id}`, { method: 'PUT', body: JSON.stringify(corpo) });
          // confere no ML e recalcula o custo do anúncio
          const novo = await ml(`/items/${id}?attributes=id,title,available_quantity,seller_custom_field,attributes,variations,status`);
          const { base, variacoes } = skusDoAnuncio(novo);
          if ([base, ...variacoes.map((v) => v.sku)].some(tem)) return { id, ok: false, trocas, erro: 'o Mercado Livre aceitou, mas o SKU antigo continua no anúncio' };
          const comp = composicao(novo, mapa);
          const custos = comp.filter((c) => c.custo != null).map((c) => c.custo);
          if (custos.length === comp.length && D.custoObter(id)?.origem !== 'manual') {
            D.custoAutoGravar(conta.ml_user_id, id, Math.round(custos.reduce((s, v) => s + v, 0) / custos.length * 100) / 100);
          }
          return { id, ok: true, trocas };
        } catch (e) { return { id, ok: false, erro: e.message }; }
      });
      cacheAnuncios = null;
      return { de, para, novo_na_tabela: mapa.has(para), pedidos: ids.length,
        alterados: resultado.filter((r) => r.ok).length, falhas: resultado.filter((r) => !r.ok), resultado };
    } },

    // Editar um produto da tabela (custo, nome, situação, fornecedor) e recalcular os anúncios.
    { m: 'PUT', re: /^\/api\/produtos\/(\d+)$/, fn: async ([n], body) => {
      const conta = contaOuErro();
      const numero = Number(n);
      const atual = D.catalogoListar().find((p) => p.numero === numero);
      if (!atual) throw erro('Produto não encontrado na tabela.', 404);
      const p = produtoDoCorpo({ ...atual, ...(body || {}) }, numero);
      D.catalogoGravar([p]);
      const anuncios = await aplicarCatalogo(conta).catch(() => []);
      const afetados = anuncios.filter((a) => a.skus.some((s) => s.componentes.some((c) => c.numero === numero)));
      return { produto: p, anuncios_recalculados: afetados.length };
    } },

    // Trocar o SKU no Mercado Livre (atributo SELLER_SKU) e recalcular o custo no painel.
    // Anúncio com variações: o PUT leva TODAS as variações pelo id — variação que fica de
    // fora do PUT é apagada pelo ML —, e só a escolhida ganha o SKU novo.
    { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)\/sku$/, fn: async ([id], body) => {
      const conta = contaOuErro();
      exigeItemId(id);
      const sku = String(body?.sku ?? '').trim();
      if (!sku || sku.length > 60) throw erro('Informe o SKU (até 60 caracteres).');
      const it = await ml(`/items/${id}?attributes=id,variations,attributes,seller_custom_field,status`);
      const vars = it.variations || [];
      let corpo;
      if (vars.length) {
        const alvo = Number(body.variacao_id);
        if (!vars.some((v) => v.id === alvo)) throw erro('Escolha a variação que vai receber o SKU.');
        corpo = { variations: vars.map((v) => (v.id === alvo
          ? { id: v.id, attributes: [{ id: 'SELLER_SKU', value_name: sku }] } : { id: v.id })) };
      } else {
        corpo = { attributes: [{ id: 'SELLER_SKU', value_name: sku }] };
      }
      await ml(`/items/${id}`, { method: 'PUT', body: JSON.stringify(corpo) });
      cacheAnuncios = null;
      const novo = await ml(`/items/${id}?attributes=id,title,available_quantity,seller_custom_field,attributes,variations,status`);
      const comp = composicao(novo);
      const custos = comp.filter((c) => c.custo != null).map((c) => c.custo);
      const atual = D.custoObter(id);
      if (custos.length === comp.length && atual?.origem !== 'manual') {
        D.custoAutoGravar(conta.ml_user_id, id, Math.round(custos.reduce((s, v) => s + v, 0) / custos.length * 100) / 100);
      }
      return { id, sku, composicao: comp };
    } },

    // Embalagem e outro custo por unidade do anúncio (etiqueta, brinde…), e custo manual opcional.
    // Embalagem vazia = vale a embalagem padrão da empresa.
    { m: 'PUT', re: /^\/api\/custos-anuncios\/([A-Z]{3}\d+)$/, fn: async ([id], body) => {
      const conta = contaOuErro();
      exigeItemId(id);
      const num = (v, nome) => {
        if (v === '' || v == null) return null;
        const n = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n) || n < 0 || n > 1e6) throw erro(`${nome} inválido.`);
        return Math.round(n * 100) / 100;
      };
      if ('embalagem' in (body || {})) D.embalagemGravar(conta.ml_user_id, id, num(body.embalagem, 'Custo de embalagem'));
      if ('outro_custo' in (body || {})) D.extraGravar(conta.ml_user_id, id, num(body.outro_custo, 'Outro custo'));
      if ('custo_manual' in (body || {})) {
        const atual = D.custoObter(id);
        const v = num(body.custo_manual, 'Custo do produto');
        if (v == null) {   // apagar o manual: volta a valer o SKU
          D.custoGravar(conta.ml_user_id, id, { custo: null, outros: atual?.outros ?? null });
          D.db.prepare("UPDATE custos SET origem=NULL WHERE item_id=?").run(id);
          cacheAnuncios = null;
        } else D.custoGravar(conta.ml_user_id, id, { custo: v, outros: atual?.outros ?? null });
      }
      return { ...D.custoObter(id), embalagem_padrao: empresaDe(conta).embalagem_padrao };
    } },
  ];

  return { rotas, rotasParam, composicao, idsComProduto, catalogoMapa };
}

module.exports = { criar, lerCatalogo, componentes, custoDoSku, skusDoAnuncio, trocarComponente, somarContas, topPorSku, validarEmpresa, lerEmpresa,
  impostoTotal, contaDaLinha, dinheiro };
