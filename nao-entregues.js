'use strict';
// Entregas não realizadas do ML (pedido do dono, 04/11/2026): a venda que SAIU para entrega, não foi entregue e voltou ao
// vendedor. O ML cancela o pedido (sem reclamação, então não aparece em Devoluções) e o estoque voltava na hora do cancelamento,
// semanas antes de o pacote chegar. Agora: venda cancelada cujo envio chegou a sair (status_history.date_shipped, ou envio
// shipped/not_delivered) fica na lista "Entregas não realizadas" da tela Devoluções e o estoque só volta quando o vendedor
// clica "Conferir" (chegou). estoque.js#linhasDeVenda segura a baixa enquanto não conferida (tabela ml_nao_entregues).
// Cada envio é lido uma vez em /shipments/{id} (relido a cada 6 h enquanto não for final). Full fica fora (volta ao armazém
// do ML). Venda com reclamação de devolução fica fora (já está nas Devoluções). Sem dado de cliente; nada no MCP.

const FINAIS = new Set(['not_delivered', 'cancelled', 'delivered']);

// A venda cancelada saiu para entrega? Pura: testada.
function saiuParaEntrega(s) {
  if (!s) return false;
  return !!s.status_history?.date_shipped || ['shipped', 'not_delivered'].includes(s.status);
}

// Peças conferidas -> a linha de devolução do estoque (estoque.js#diferencas): sem = posições com dano, defeituosos = quantas
// danificadas, faltam = as que não chegaram. pecas null (conferida sem detalhe) = tudo bom. Pura: testada.
function devolucaoDe(qtd, nPos, pecas) {
  if (!Array.isArray(pecas)) return { sem: null, defeituosos: null, faltam: null };
  const sem = [], defeituosos = {}, faltam = {};
  for (let i = 0; i < nPos; i++) {
    const p = pecas[i] || { boas: qtd, ruins: 0 };
    const boas = Math.max(0, Math.min(qtd, Math.round(Number(p.boas) || 0)));
    const ruins = Math.max(0, Math.min(qtd - boas, Math.round(Number(p.ruins) || 0)));
    if (ruins) { sem.push(i); defeituosos[i] = ruins; }
    if (qtd - boas - ruins > 0) faltam[i] = qtd - boas - ruins;
  }
  return { sem: sem.length ? sem : null, defeituosos: sem.length ? defeituosos : null, faltam: Object.keys(faltam).length ? faltam : null };
}

function criar({ D, ml, CTX, contaOuErro, estoque }) {
  D.db.exec(`CREATE TABLE IF NOT EXISTS ml_nao_entregues (envio_id INTEGER PRIMARY KEY, ml_user_id INTEGER NOT NULL,
    saiu INTEGER NOT NULL, status TEXT, substatus TEXT, enviado_em TEXT, lido_em TEXT NOT NULL,
    conferido_em TEXT, quem TEXT, obs TEXT)`);
  // pecas: JSON [{ boas, ruins }] por posição do kit (numerosDoCodigo do SKU), dito no Conferir
  if (!D.db.prepare('PRAGMA table_info(ml_nao_entregues)').all().some((c) => c.name === 'pecas')) D.db.exec('ALTER TABLE ml_nao_entregues ADD COLUMN pecas TEXT');
  const { numerosDoCodigo } = require('./estoque.js');
  const pecasDoKit = (sku) => {
    const cat = estoque?.()?.catalogo?.(); if (!cat || !sku) return [];
    return numerosDoCodigo(sku, cat.porSku, { doCanal: true }).map((n, pos) => ({ pos, numero: n, sku: cat.porNumero.get(n)?.sku || String(n), nome: cat.porNumero.get(n)?.nome || null }));
  };
  const lerEnvio = D.db.prepare('SELECT * FROM ml_nao_entregues WHERE envio_id=?');
  const gravar = D.db.prepare(`INSERT INTO ml_nao_entregues (envio_id, ml_user_id, saiu, status, substatus, enviado_em, lido_em)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(envio_id) DO UPDATE SET saiu=excluded.saiu, status=excluded.status,
    substatus=excluded.substatus, enviado_em=excluded.enviado_em, lido_em=excluded.lido_em`);
  // vendas canceladas do depósito (Full fora), sem reclamação de devolução, com envio
  const canceladas = (contaId, desde) => D.db.prepare(`SELECT v.envio_id, MIN(v.data) AS data FROM vendas v
      WHERE v.ml_user_id=? AND v.data >= ? AND v.status='cancelled' AND v.envio_id IS NOT NULL
        AND (v.origem IS NULL OR v.origem = '' OR v.origem LIKE 'BRP%')
        AND NOT EXISTS (SELECT 1 FROM devolucoes d WHERE d.order_id = v.order_id)
      GROUP BY v.envio_id`).all(contaId, desde);

  // Lê os envios que faltam (até `max` por vez). Roda DENTRO de CTX.comConta(conta).
  async function verificar(conta, max = 60) {
    const desde = new Date(Date.now() - 60 * 864e5).toISOString();
    const faltam = canceladas(conta.ml_user_id, desde).filter((c) => {
      const r = lerEnvio.get(c.envio_id);
      return !r || (!r.conferido_em && !FINAIS.has(r.status) && Date.now() - Date.parse(r.lido_em) > 6 * 3600e3);
    }).slice(0, max);
    for (const c of faltam) {
      const s = await ml(`/shipments/${c.envio_id}`).catch(() => null);
      if (!s) continue;
      gravar.run(c.envio_id, conta.ml_user_id, saiuParaEntrega(s) ? 1 : 0, s.status || null, s.substatus || null,
        s.status_history?.date_shipped || null, new Date().toISOString());
    }
    return faltam.length;
  }

  function lista(contaId) {
    return D.db.prepare(`SELECT n.*, v.order_id, v.pack_id, v.item_id, v.sku, v.quantidade, v.preco_unit, v.data
        FROM ml_nao_entregues n JOIN vendas v ON v.envio_id = n.envio_id AND v.ml_user_id = n.ml_user_id
        WHERE n.ml_user_id=? AND n.saiu=1 AND v.status='cancelled' ORDER BY v.data DESC`).all(contaId);
  }

  const rotas = {
    // ?conferidas=1 também traz as já conferidas
    'GET /api/devolucoes/nao-entregues': async (url) => {
      const conta = contaOuErro();
      await CTX.comConta(conta.ml_user_id, () => verificar(conta, 40)).catch(() => null);
      const linhas = lista(conta.ml_user_id).filter((l) => url.searchParams.get('conferidas') === '1' || !l.conferido_em);
      const ids = [...new Set(linhas.map((l) => l.item_id))];
      const info = {};
      for (let i = 0; i < ids.length; i += 20) {
        const r = await CTX.comConta(conta.ml_user_id, () => ml(`/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,thumbnail,permalink`)).catch(() => []);
        for (const x of r || []) if (x.body?.id) info[x.body.id] = x.body;
      }
      const inicio = D.configLer('estoque_inicio') || null;
      return { inicio, itens: linhas.map((l) => ({ envio: l.envio_id, pedido: l.order_id, pacote: l.pack_id || null, data: l.data,
        item_id: l.item_id, titulo: info[l.item_id]?.title || null, foto: info[l.item_id]?.thumbnail || null, link: info[l.item_id]?.permalink || null,
        sku: l.sku || null, quantidade: l.quantidade, valor: Math.round(l.quantidade * l.preco_unit * 100) / 100,
        status_envio: l.status, substatus: l.substatus, enviado_em: l.enviado_em,
        conferido_em: l.conferido_em, quem: l.quem, obs: l.obs, segura_estoque: !!inicio && l.data >= inicio && !l.conferido_em,
        pecas_kit: pecasDoKit(l.sku), pecas: (() => { try { return JSON.parse(l.pecas || 'null'); } catch { return null; } })() })) };
    },
    // { envio, desfazer?, obs? }: chegou (o estoque volta na próxima baixa) ou desfaz a conferência
    'POST /api/devolucoes/nao-entregues/conferir': async (_u, body) => {
      const envio = Number(body?.envio);
      const r = Number.isInteger(envio) ? lerEnvio.get(envio) : null;
      if (!r || !r.saiu || String(r.ml_user_id) !== String(contaOuErro().ml_user_id)) throw Object.assign(new Error('Entrega não encontrada.'), { status: 400 });
      if (body?.desfazer) { D.db.prepare('UPDATE ml_nao_entregues SET conferido_em=NULL, quem=NULL, pecas=NULL WHERE envio_id=?').run(envio); return { ok: true }; }
      // quantas de cada peça chegaram boas e danificadas (o resto = não chegou); sem a lista = todas boas
      const v = D.db.prepare('SELECT sku, SUM(quantidade) AS q FROM vendas WHERE envio_id=? GROUP BY envio_id').get(envio);
      const qtd = Math.round(v?.q || 0), nPos = pecasDoKit(v?.sku).length || 1;
      let pecas = null;
      if (Array.isArray(body?.pecas)) {
        pecas = Array.from({ length: nPos }, (_, i) => {
          const p = body.pecas[i] || {};
          const boas = Math.round(Number(p.boas)), ruins = Math.round(Number(p.ruins) || 0);
          if (!Number.isInteger(boas) || boas < 0 || ruins < 0 || boas + ruins > qtd) throw Object.assign(new Error(`Peça ${i + 1}: boas + danificadas vai de 0 a ${qtd}.`), { status: 400 });
          return { boas, ruins };
        });
      }
      D.db.prepare('UPDATE ml_nao_entregues SET conferido_em=?, quem=?, obs=?, pecas=? WHERE envio_id=?')
        .run(new Date().toISOString(), (CTX.atual()?.usuario?.nome || CTX.atual()?.usuario?.login || 'administrador'), String(body?.obs || '').slice(0, 300) || null, pecas ? JSON.stringify(pecas) : null, envio);
      return { ok: true };
    },
  };

  return { rotas, verificar };
}

module.exports = { criar, saiuParaEntrega, devolucaoDe };
