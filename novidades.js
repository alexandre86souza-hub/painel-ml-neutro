'use strict';
// Novidades das lojas (pedido do dono, 04/11/2026): aviso no sino (e no e-mail de alertas) quando aparece
//   - campanha nova para a conta do ML (/seller-promotions/users/{id}: as que o ML abre para o vendedor entrar);
//   - promoção nova na Magalu (a mesma lista da tela Campanhas, magalu.js#promocoesDaLoja) e na Leroy (PR01 /api/promotions);
//   - anúncio novo na conta do ML (os 50 mais novos por start_time_desc), inclusive os que o próprio ML cria no catálogo.
// Shopee (campanhas da Shopee) e Amazon (convites) não têm API: ficam de fora. Confere de 30 em 30 min no segundo plano dos
// avisos. A 1ª leitura de cada lista só vira a base (não despeja o que já existia). Estado em `estado` novidades:{chave}. Nada no MCP.

const { tipoNome } = require('./promocoes.js');

const dataBR = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }) : null);
const periodo = (ini, fim) => (ini || fim ? `${dataBR(ini) || '?'} a ${dataBR(fim) || '?'}` : null);

// Ids da lista que ainda não foram vistos; a 1ª leitura (vistos = null) não avisa nada. Pura: testada.
function novosDe(vistos, ids) {
  const lista = [...new Set(ids.map(String).filter(Boolean))];
  if (!vistos) return { novos: [], vistos: lista };
  const conhecidos = new Set(vistos);
  return { novos: lista.filter((x) => !conhecidos.has(x)), vistos: [...new Set([...lista, ...vistos])].slice(0, 5000) };
}

// Texto do aviso de campanha nova do ML. Pura: testada.
function textoCampanhaMl(p) {
  return [tipoNome(p.type), periodo(p.start_date, p.finish_date), p.deadline_date ? `entrar até ${dataBR(p.deadline_date)}` : null]
    .filter(Boolean).join(' · ');
}

function criar({ D, ml, magalu, leroy }) {
  const ler = (k) => { try { return JSON.parse(D.configLer(`novidades:${k}`) || 'null'); } catch { return null; } };
  const gravar = (k, v) => D.configGravar(`novidades:${k}`, JSON.stringify(v));
  // compara a lista com a guardada, grava e devolve só os novos
  const comparar = (k, ids) => { const r = novosDe(ler(k), ids); gravar(k, r.vistos); return r.novos; };
  const ultima = new Map();
  const vez = (k) => { if (Date.now() - (ultima.get(k) || 0) < 30 * 60e3) return false; ultima.set(k, Date.now()); return true; };
  const paraTodas = (a) => { for (const c of D.contasListar()) D.avisoCriar(c.ml_user_id, a); };

  // Roda DENTRO de CTX.comConta(conta) (o ml() usa a conta do contexto).
  async function verificarConta(conta) {
    const id = String(conta.ml_user_id);
    if (!vez(`ml:${id}`)) return;
    const promos = (await ml(`/seller-promotions/users/${id}?app_version=v2`).catch(() => null))?.results;
    if (Array.isArray(promos)) {
      const porId = new Map(promos.filter((p) => p?.id).map((p) => [String(p.id), p]));
      for (const pid of comparar(`ml_promo:${id}`, [...porId.keys()])) {
        const p = porId.get(pid);
        D.avisoCriar(id, { tipo: 'campanha', chave: `campanha:ml:${pid}`, titulo: `Campanha nova no Mercado Livre: ${p.name || tipoNome(p.type)}`,
          texto: textoCampanhaMl(p), link: '/promocoes.html' });
      }
    }
    const busca = (await ml(`/users/${id}/items/search?orders=start_time_desc&limit=50`).catch(() => null))?.results;
    if (Array.isArray(busca)) {
      const novos = comparar(`ml_itens:${id}`, busca);
      for (let i = 0; i < novos.length; i += 20) {
        const r = await ml(`/items?ids=${novos.slice(i, i + 20).join(',')}&attributes=id,title,price,catalog_listing,listing_type_id,status`).catch(() => []);
        for (const x of r || []) {
          const it = x.body; if (!it?.id) continue;
          const preco = it.price != null ? Number(it.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null;
          D.avisoCriar(id, { tipo: 'anuncio_novo', chave: `anuncio_novo:${it.id}`, titulo: `Anúncio novo na conta${it.catalog_listing ? ' (catálogo)' : ''}`,
            texto: [`${it.title || it.id} (${it.id})`, preco, it.listing_type_id === 'gold_pro' ? 'Premium' : it.listing_type_id === 'gold_special' ? 'Clássico' : null,
              it.status === 'active' ? null : it.status].filter(Boolean).join(' · '),
            link: `/anuncios.html?q=${encodeURIComponent(it.id)}` });
        }
      }
    }
  }

  async function verificarLojas() {
    if (magalu?.config()?.refresh && vez('magalu')) {
      const l = await magalu.promocoesDaLoja().catch(() => null);
      if (Array.isArray(l)) {
        const porId = new Map(l.filter((p) => p?.id).map((p) => [String(p.id), p]));
        for (const pid of comparar('magalu_promo', [...porId.keys()])) {
          const p = porId.get(pid);
          paraTodas({ tipo: 'campanha', chave: `campanha:magalu:${pid}`, titulo: `Promoção nova na Magalu: ${p.nome || p.tipo_nome || pid}`,
            texto: [p.tipo_nome, periodo(p.inicio, p.fim), p.prazo ? `entrar até ${dataBR(p.prazo)}` : null].filter(Boolean).join(' · '),
            link: '/campanhas-canais.html?conta=magalu' });
        }
      }
    }
    if (leroy?.config()?.api_key && vez('leroy')) {
      const r = await leroy.mk(leroy.config(), '/api/promotions', { max: 100 }).catch(() => null);
      if (Array.isArray(r?.promotions)) {
        const porId = new Map(r.promotions.map((x) => [String(x.internal_id ?? x.id ?? ''), x]).filter(([k]) => k));
        for (const pid of comparar('leroy_promo', [...porId.keys()])) {
          const x = porId.get(pid);
          paraTodas({ tipo: 'campanha', chave: `campanha:leroy:${pid}`,
            titulo: `Promoção nova na Leroy: ${x.internal_description || x.public_descriptions?.[0]?.value || pid}`,
            texto: [x.type, periodo(x.start_date, x.end_date), x.state].filter(Boolean).join(' · '), link: '/campanhas-canais.html?conta=leroy' });
        }
      }
    }
  }

  return { verificarConta, verificarLojas };
}

module.exports = { criar, novosDe, textoCampanhaMl };
