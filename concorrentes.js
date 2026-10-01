'use strict';
// Concorrentes de um anúncio no Mercado Livre (tela Anúncios → Detalhes → Concorrentes).
//
// A API do ML não deixa ler busca nem anúncio de outro vendedor (/sites/MLB/search e
// /items/{id} de terceiros dão 403, medido em 01/10/2026). Os concorrentes vêm da página de
// busca pelo scraper — o mesmo da tela Posição —, que traz preço, vendedor, posição,
// patrocinado, frete grátis e os "vendidos". Os vendidos são o TOTAL da vida do anúncio e
// vêm em FAIXAS (25, 50, 100, 500, 1000, 10000…): venda de 30 dias de concorrente o ML não
// mostra em lugar nenhum. Cada busca guarda a faixa de cada um, e a tela mostra quando ele
// subiu de faixa — o mais perto de "vendas recentes" que existe.
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Termo de busca a partir do título: as primeiras palavras, sem números de modelo e
// símbolos (o comprador busca "ducha redonda cromada", não "KIT-765.714"). Função pura: testada.
function termoDoTitulo(titulo, palavras = 5) {
  return String(titulo || '').toLowerCase().split(/\s+/)
    .filter((p) => !/\d/.test(p))                       // o código inteiro sai (KIT-765.714), não só os números
    .map((p) => p.replace(/[^a-zà-ú]/gi, ''))
    .filter((p) => p.length > 1 && !['com', 'para', 'de', 'da', 'do', 'em', 'e', 'c'].includes(p))
    .slice(0, palavras).join(' ');
}

// Faixa de vendidos ao longo das medições: a atual, desde quando, e a anterior (quando subiu).
// Medições sem número (o ML não mostrou) não contam. Função pura: testada.
function historicoFaixa(medidas) {
  const m = medidas.filter((x) => x.vendidos != null);
  if (!m.length) return { faixa: null, desde: null, anterior: null, primeira_medida: medidas[0]?.medido_em || null };
  const atual = m.at(-1).vendidos;
  let i = m.length - 1;
  while (i > 0 && m[i - 1].vendidos === atual) i--;
  return { faixa: atual, desde: m[i].medido_em, anterior: i > 0 ? m[i - 1].vendidos : null, primeira_medida: m[0].medido_em };
}

// Nome de vendedor que é de uma das contas conectadas (a busca não diz o vendedor de cada
// anúncio pela API; o card mostra o nome). Função pura: testada.
const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
function ehDaCasa(vendedor, nomes) {
  const v = normal(vendedor);
  return !!v && nomes.map(normal).filter((n) => n.length >= 3).some((n) => v.includes(n) || n.includes(v));
}

function criar({ D, ml, scraper, contaOuErro, exigeItemId, classificarBusca, lembrarSessao }) {
  const nomesDaCasa = () => D.contasListar().flatMap((c) => [c.nickname, D.configLer(`marca_nome:${c.ml_user_id}`)]).filter(Boolean);

  const comFaixa = (r) => {
    const h = historicoFaixa(D.concMedidas(r.item_id));
    return { ...r, faixa_desde: h.desde, faixa_anterior: h.anterior, acompanhado_desde: h.primeira_medida,
      link: `https://produto.mercadolivre.com.br/MLB-${r.item_id.replace(/^MLB/, '')}` };
  };

  const rotas = {
    // Busca no ML e devolve os concorrentes. termo vazio: o primeiro termo acompanhado na
    // Posição, ou as primeiras palavras do título.
    'POST /api/concorrentes/buscar': async (_u, body) => {
      const conta = contaOuErro();
      const id = exigeItemId(body?.item);
      let termo = String(body?.termo || '').trim().toLowerCase();
      if (!termo) termo = D.palavrasListar(id)[0]?.termo || '';
      if (!termo) termo = termoDoTitulo((await ml(`/items/${id}?attributes=title`)).title);
      if (termo.length < 2) throw erro('Informe um termo de busca.');
      let r;
      try { r = await scraper(`/posicao?item=${id}&q=${encodeURIComponent(termo)}&paginas=1`); }
      catch (e) {
        if (e.status === 503 && e.body?.cause?.acao) lembrarSessao('bloqueada', e.body.cause.acao);
        throw e;
      }
      lembrarSessao('valida');
      const { lista } = await classificarBusca(conta, id, r.resultados || [], r.posicao);
      const nomes = nomesDaCasa();
      const marcados = new Set(D.concDoItem(id).map((c) => c.conc_item));
      const outros = lista.filter((x) => x.item_id !== id && x.seu !== true && !ehDaCasa(x.vendedor, nomes));
      // um anúncio pode aparecer duas vezes (patrocinado e orgânico): fica a melhor posição
      const unicos = [...new Map(outros.slice().reverse().map((x) => [x.item_id, x])).values()].sort((a, b) => a.posicao - b.posicao);
      D.concMedidasGravar(unicos);
      D.concAtualizar(id, unicos.filter((x) => marcados.has(x.item_id)));
      const daCasa = lista.filter((x) => x.item_id !== id && (x.seu === true || ehDaCasa(x.vendedor, nomes))).length;
      return { item: id, termo, minha_posicao: r.posicao ?? null, total: lista.length, da_casa: daCasa,
        falhas: r.falhas || [], resultados: unicos.map((x) => ({ ...comFaixa(x), marcado: marcados.has(x.item_id) })),
        marcados: D.concDoItem(id).map(comFaixaMarcado) };
    },
    'POST /api/concorrentes/marcar': async (_u, body) => {
      const conta = contaOuErro();
      const id = exigeItemId(body?.item);
      const c = body?.concorrente || {};
      if (!/^MLB\d+$/.test(String(c.item_id || ''))) throw erro('Concorrente inválido.');
      D.concMarcar(conta.ml_user_id, id, c);
      return { marcados: D.concDoItem(id).map(comFaixaMarcado) };
    },
    'POST /api/concorrentes/desmarcar': async (_u, body) => {
      contaOuErro();
      const id = exigeItemId(body?.item);
      D.concDesmarcar(id, String(body?.conc || ''));
      return { marcados: D.concDoItem(id).map(comFaixaMarcado) };
    },
    'GET /api/concorrentes': async (url) => {
      contaOuErro();
      const id = exigeItemId(url.searchParams.get('item'));
      return { marcados: D.concDoItem(id).map(comFaixaMarcado) };
    },
  };
  function comFaixaMarcado(c) {
    const h = historicoFaixa(D.concMedidas(c.conc_item));
    return { ...c, item_id: c.conc_item, frete_gratis: !!c.frete_gratis, faixa_desde: h.desde, faixa_anterior: h.anterior,
      acompanhado_desde: h.primeira_medida, link: `https://produto.mercadolivre.com.br/MLB-${c.conc_item.replace(/^MLB/, '')}` };
  }
  return { rotas, rotasParam: [] };
}

module.exports = { criar, termoDoTitulo, historicoFaixa, ehDaCasa };
