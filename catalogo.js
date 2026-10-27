'use strict';
// Disputa do catálogo do ML (pedido do dono, 27/10/2026: a notificação "Volte a ganhar da concorrência"). Para cada anúncio
// ATIVO de catálogo, `/items/{id}/price_to_win?version=v2` diz se está ganhando, dividindo ou perdendo o botão de compra e o
// preço para ganhar. Confere de 30 em 30 min por conta, em segundo plano. Perdeu (antes ganhava/dividia, ou anúncio novo
// já perdendo) = aviso no sino, com o lucro e a margem no preço para ganhar e "vale baixar" (margem ≥ mínima, padrão 15%)
// ou "não compensa". Só sino e o resumo do e-mail das 7h30 — a disputa muda muitas vezes ao dia. Nada muda preço sozinho.
// Estado por conta em `estado` (catalogo_comp:{conta}). Nada no MCP.

const MARGEM_MIN_PADRAO = 15;
const SITUACAO = { winning: 'ganhando', sharing_first_place: 'dividindo', competing: 'perdendo', listed: 'sem disputa' };
const VANTAGENS = { free_shipping: 'frete grátis', fulfillment: 'Full', free_installments: 'parcelamento sem juros',
  same_day_shipping: 'envio no mesmo dia', shipping_guaranteed: 'entrega garantida', fast_shipping: 'envio rápido' };
const r2 = (v) => Math.round(v * 100) / 100;
const real = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pctTxt = (m) => (m == null ? '—' : (m * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');

// O que guardar de uma resposta do price_to_win. Função pura: testada.
function leitura(r) {
  const boosts = Array.isArray(r?.boosts) ? r.boosts : [];
  const falta = boosts.filter((b) => b?.status === 'opportunity').map((b) => VANTAGENS[b.id] || String(b.id || '').replace(/_/g, ' '));
  return {
    situacao: r?.status || null, preco: r?.current_price ?? null, preco_ganhar: r?.price_to_win ?? null,
    vencedor_preco: r?.winner?.price ?? null, dividem: r?.competitors_sharing_first_place ?? null,
    visitas: r?.visit_share || null, falta, motivos: Array.isArray(r?.reason) ? r.reason.slice(0, 5) : [],
  };
}

// "vale" = no preço para ganhar a margem fica na mínima ou acima; "nao_compensa" = abaixo; null = sem custo/sem preço. Pura.
function veredito(margem, margemMinPct) {
  if (margem == null) return null;
  return margem * 100 >= margemMinPct ? 'vale' : 'nao_compensa';
}

// Texto do aviso do sino. Função pura: testada.
function textoDoAviso(x, margemMinPct) {
  const partes = [`Seu preço ${real(x.preco)}`];
  if (x.preco_ganhar != null) {
    const queda = x.preco ? (x.preco - x.preco_ganhar) / x.preco : null;
    partes.push(`para ganhar: ${real(x.preco_ganhar)}${queda != null && queda > 0 ? ` (−${pctTxt(queda)})` : ''}`);
    if (x.lucro_ganhar != null) {
      partes.push(`lucro nesse preço ${real(x.lucro_ganhar)} (margem ${pctTxt(x.margem_ganhar)})`);
      partes.push(x.veredito === 'vale' ? `vale baixar (margem ≥ ${margemMinPct}%)` : `não compensa (margem abaixo de ${margemMinPct}%)`);
    } else if (x.lucro_erro) partes.push(x.lucro_erro);
  } else partes.push('o preço sozinho não ganha');
  if (x.falta?.length) partes.push(`o ganhador tem: ${x.falta.join(', ')}`);
  return partes.join(' · ');
}

// Avisos de uma leitura nova contra a anterior: só quem PASSOU a perder (ou apareceu já perdendo). Pura: testada.
function quemPassouAPerder(antes, agora) {
  if (!antes) return [];   // 1ª leitura da conta: vira a base, sem aviso
  return Object.entries(agora).filter(([id, x]) => x.situacao === 'competing' && antes[id]?.situacao !== 'competing').map(([id]) => id);
}

function criar({ ml, D, emLotes, idsDaConta, lucroNosPrecos, contaOuErro }) {
  const margemMin = () => Number(D.configLer('catalogo_margem_min')) || MARGEM_MIN_PADRAO;
  const ler = (id) => { try { return JSON.parse(D.configLer(`catalogo_comp:${id}`) || 'null'); } catch { return null; } };
  const rodando = new Set();

  // Roda DENTRO de CTX.comConta(conta) (o ml() usa a conta do contexto).
  async function verificar(conta, { forcar = false } = {}) {
    const id = String(conta.ml_user_id);
    const salvo = ler(id);
    if (rodando.has(id) || (!forcar && salvo && Date.now() - Date.parse(salvo.em) < 30 * 60e3)) return salvo;
    rodando.add(id);
    try {
      const { ids } = await idsDaConta(conta, 'active');
      const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
      const cat = [];
      await emLotes(lotes, 3, async (l) => {
        const r = await ml(`/items?ids=${l.join(',')}&attributes=id,title,price,catalog_listing,status`).catch(() => []);
        for (const x of r || []) if (x.body?.catalog_listing && x.body.status === 'active') cat.push(x.body);
      });
      const antes = salvo?.itens || null, agora = {}, min = margemMin();
      await emLotes(cat, 3, async (it) => {
        const r = await ml(`/items/${it.id}/price_to_win?version=v2`).catch((e) => ({ erro: e.message }));
        if (r?.erro) { agora[it.id] = { titulo: it.title, situacao: null, erro: String(r.erro).slice(0, 160), preco: it.price }; return; }
        const x = { titulo: it.title, ...leitura(r) };
        if (x.preco == null) x.preco = it.price;
        if (x.situacao === 'competing' && x.preco_ganhar != null) {
          const a = antes?.[it.id];
          if (a && a.preco_ganhar === x.preco_ganhar && a.preco === x.preco && (a.lucro_ganhar != null || a.lucro_erro)) {
            Object.assign(x, { lucro_ganhar: a.lucro_ganhar, margem_ganhar: a.margem_ganhar, lucro_atual: a.lucro_atual, margem_atual: a.margem_atual, lucro_erro: a.lucro_erro });
          } else {
            try {
              const l = await lucroNosPrecos(conta, it.id, [r2(x.preco_ganhar), r2(x.preco)]);
              const [g, at] = l.precos;
              Object.assign(x, { lucro_ganhar: g?.lucro ?? null, margem_ganhar: g?.margem ?? null, lucro_atual: at?.lucro ?? null, margem_atual: at?.margem ?? null });
            } catch (e) { x.lucro_erro = String(e.message || e).slice(0, 160); }
          }
          x.veredito = veredito(x.margem_ganhar, min);
        }
        agora[it.id] = x;
      });
      const novo = { em: new Date().toISOString(), margem_min: min, itens: agora };
      D.configGravar(`catalogo_comp:${id}`, JSON.stringify(novo));
      const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
      for (const iid of quemPassouAPerder(antes, agora)) {
        const x = agora[iid];
        D.avisoCriar(id, { tipo: 'catalogo', chave: `catalogo:${iid}:${dia}`,
          titulo: `Perdendo no catálogo${x.veredito === 'vale' ? ': vale baixar' : x.veredito === 'nao_compensa' ? ': não compensa baixar' : ''}`,
          texto: `${x.titulo || iid} (${iid}) · ${textoDoAviso(x, min)}`, link: `/anuncios.html?q=${encodeURIComponent(iid)}` });
      }
      return novo;
    } finally { rodando.delete(id); }
  }

  // Resumo de uma conta (tela/e-mail): contagem por situação e os que estão perdendo, "vale baixar" primeiro.
  function resumo(id) {
    const s = ler(String(id));
    if (!s) return null;
    const itens = Object.entries(s.itens || {}).map(([iid, x]) => ({ id: iid, ...x, situacao_txt: SITUACAO[x.situacao] || (x.erro ? 'erro na leitura' : x.situacao) }));
    const conta = {}; for (const x of itens) conta[x.situacao || 'erro'] = (conta[x.situacao || 'erro'] || 0) + 1;
    const ordem = { vale: 0, nao_compensa: 1 };
    const perdendo = itens.filter((x) => x.situacao === 'competing')
      .sort((a, b) => (ordem[a.veredito] ?? 2) - (ordem[b.veredito] ?? 2) || (b.margem_ganhar ?? -9) - (a.margem_ganhar ?? -9));
    return { em: s.em, margem_min: s.margem_min, total: itens.length, ganhando: conta.winning || 0, dividindo: conta.sharing_first_place || 0,
      perdendo: conta.competing || 0, sem_disputa: conta.listed || 0, erros: conta.erro || 0, lista_perdendo: perdendo };
  }

  const rotas = {
    // Disputa do catálogo da conta escolhida (?recarregar=1 lê de novo agora). Só leitura.
    'GET /api/catalogo/competicao': async (url) => {
      const conta = contaOuErro();
      if (url.searchParams.get('recarregar') || !ler(conta.ml_user_id)) await verificar(conta, { forcar: true });
      return { ...resumo(conta.ml_user_id), itens: ler(conta.ml_user_id)?.itens || {} };
    },
  };
  return { rotas, verificar, resumo };
}

module.exports = { criar, leitura, veredito, textoDoAviso, quemPassouAPerder, MARGEM_MIN_PADRAO };
