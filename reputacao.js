'use strict';
// Reputação (tela public/reputacao.html): o termômetro da conta e as vendas que afetaram (ou
// podem afetar) a reputação, com uma sugestão de solução ou contestação para cada uma.
//
// Medido em 02/10/2026 nas duas contas:
//   - /users/{id}.seller_reputation: level_id (5_green…1_red), power_seller_status e metrics
//     (60 dias) de claims, delayed_handling_time e cancellations, cada uma com rate e value.
//     A conta tinha claims.value = 3 — e eram exatamente as 3 reclamações abaixo com "affected".
//   - /post-purchase/v1/claims/{id}/affects-reputation -> { affects_reputation: affected |
//     not_affected, has_incentive, due_date }: diz, reclamação por reclamação, se ela conta.
//   - /post-purchase/v1/claims/{id}/detail: o texto do ML (problema, descrição, prazo e de quem é
//     a vez). players[].available_actions do vendedor: o que ele ainda pode fazer (responder,
//     reembolsar, open_dispute = levar à mediação/contestar), com prazo.
//   - Cancelamentos: /orders/search order.status=cancelled; cancel_detail.requested_by/group diz
//     quem cancelou (só o vendedor pesa na reputação; comprador e mediação do ML não).
//   - Atrasos no despacho: só o número da métrica (a API não lista as vendas atrasadas).
// Cache: rep_reclamacoes guarda o "afeta?" de cada reclamação pelo last_updated (uma chamada por
// reclamação só quando ela muda).

const DIAS = 90;            // reclamações lidas (a métrica do ML é de 60 dias)
const METRICA_DIAS = 60;

const NIVEIS = { '5_green': ['Verde', 'verde'], '4_light_green': ['Verde-claro', 'verde-claro'], '3_yellow': ['Amarela', 'amarela'],
  '2_orange': ['Laranja', 'laranja'], '1_red': ['Vermelha', 'vermelha'] };
const LIDER = { platinum: 'MercadoLíder Platinum', gold: 'MercadoLíder Gold', silver: 'MercadoLíder', null: null };

// Categoria do problema pelo texto do ML. Função pura: testada.
// codigo = reason.name do ML (medido: broken_item, different_than_published…), mais estável que o texto.
function categoriaDe(texto, codigo) {
  const k = String(codigo || '').toLowerCase();
  if (/different|not_as_described|wrong/.test(k)) return 'diferente';
  if (/broken|defect|damag|not_working|doesnt_work/.test(k)) return 'defeito';
  if (/incomplete|missing/.test(k)) return 'incompleto';
  if (/not_received|undelivered|not_delivered|lost/.test(k)) return 'nao_recebeu';
  if (/repent|regret|not_wanted|changed_mind/.test(k)) return 'arrependimento';
  const t = (texto || '').toLowerCase();
  if (/não é igual|diferente|não corresponde|outro produto|errado/.test(t)) return 'diferente';
  if (/não funciona|defeito|quebrad|danificad|avaria|estragad/.test(t)) return 'defeito';
  if (/incomplet|falt(a|am|ando)|peças/.test(t)) return 'incompleto';
  if (/não (chegou|recebeu|recebi)|não foi entregue|extravi/.test(t)) return 'nao_recebeu';
  if (/arrepend|não quer|desist|mudou de ideia/.test(t)) return 'arrependimento';
  return 'outro';
}

const NOMES = { diferente: 'Produto diferente do anúncio', defeito: 'Defeito ou avaria', incompleto: 'Produto incompleto',
  nao_recebeu: 'Não recebeu', arrependimento: 'Arrependimento', outro: 'Outro motivo' };

// Sugestão de solução ou contestação para uma reclamação. Função pura: testada.
// r = { categoria, afeta, aberta, acoes: [..], pedido, produto }
function sugestaoDe(r) {
  const acoes = new Set(r.acoes || []);
  const pedido = r.pedido ? `pedido ${r.pedido}` : 'esta venda';
  const produto = r.produto ? `"${r.produto}"` : 'o produto';
  const passos = [];
  let titulo, mensagem;
  const contestar = acoes.has('open_dispute');
  switch (r.categoria) {
    case 'diferente':
      titulo = r.afeta ? 'Contestar com provas de que o produto é o do anúncio' : 'Evitar que vire mediação';
      passos.push('Separe as provas: fotos do produto e da embalagem antes do envio, a nota fiscal e as fotos/medidas do anúncio.',
        'Compare com o que o comprador disse: se o anúncio tem a medida, cor ou modelo certos, aponte o trecho exato.',
        'Se o anúncio deixou dúvida (medida, acabamento, compatibilidade), corrija-o hoje para não repetir.');
      mensagem = `Olá! Sobre o ${pedido}: enviamos ${produto} exatamente como descrito no anúncio (modelo, medidas e acabamento). Seguem as fotos do produto e da embalagem feitas antes do envio e a nota fiscal. Pedimos que a reclamação não afete a nossa reputação, já que o item corresponde ao anúncio. Se houver algo diferente, podemos ajudar com a troca.`;
      break;
    case 'defeito':
      titulo = r.afeta ? 'Contestar mostrando o teste antes do envio, ou resolver pela garantia' : 'Resolver rápido: troca ou reembolso';
      passos.push('Se o produto foi testado antes do envio, junte o vídeo ou foto do teste e o número de série/lote.',
        'Peça ao comprador foto ou vídeo do defeito: muitas vezes é instalação (ex.: pressão da água, vedação).',
        'Ofereça a troca pela garantia antes do prazo: resolvida a tempo, a reclamação não chega à mediação.');
      mensagem = `Olá! Sentimos pelo problema com ${produto} (${pedido}). Todos os nossos produtos são conferidos antes do envio. Pode nos enviar uma foto ou vídeo mostrando o defeito e como foi feita a instalação? Assim resolvemos rapidamente com a troca ou o reembolso, pela garantia.`;
      break;
    case 'incompleto':
      titulo = r.afeta ? 'Contestar com a foto do pacote conferido e o peso do envio' : 'Enviar a peça que falta';
      passos.push('Junte a foto do pacote aberto com todas as peças (se houver) e o peso registrado na etiqueta do envio.',
        'Se faltou mesmo, envie a peça e avise o comprador pela mensagem: resolve sem devolução.',
        'Inclua na embalagem uma lista do que vai no kit.');
      mensagem = `Olá! Sobre o ${pedido}: o kit de ${produto} sai conferido e com todas as peças (segue a foto da conferência e o peso do pacote). Pode nos dizer qual peça está faltando? Enviamos imediatamente, sem custo.`;
      break;
    case 'nao_recebeu':
      titulo = r.afeta ? 'Contestar: a entrega é responsabilidade do Mercado Envios' : 'Acompanhar o rastreio e responder com ele';
      passos.push('Abra o rastreio do envio: se foi pelo Mercado Envios e consta entrega ou extravio, a responsabilidade é do ML.',
        'No Flex, junte o comprovante de entrega (foto, assinatura ou localização do entregador).',
        'Responda ao comprador com o rastreio antes do prazo.');
      mensagem = `Olá! Sobre o ${pedido}: o envio foi feito dentro do prazo e o rastreio mostra a movimentação da entrega pelo transportador. Como a entrega é feita pelo Mercado Envios, pedimos que a reclamação não afete a nossa reputação. Seguimos à disposição para ajudar a localizar o pacote.`;
      break;
    case 'arrependimento':
      titulo = 'Aceitar a devolução (arrependimento costuma não afetar a reputação)';
      passos.push('Aceite a devolução dentro do prazo: arrependimento é direito do comprador e, resolvido assim, não conta contra você.',
        'Quando o produto voltar, confira o estado na revisão antes de concordar com o reembolso.');
      mensagem = `Olá! Tudo bem, pode fazer a devolução de ${produto} (${pedido}) pelo próprio Mercado Livre. Assim que recebermos e conferirmos o produto, o reembolso é liberado.`;
      break;
    default:
      titulo = r.afeta ? 'Pedir revisão do impacto com as provas da venda' : 'Responder ao comprador antes do prazo';
      passos.push('Leia a descrição do ML e responda ao comprador com a solução antes do prazo.',
        'Junte as provas (fotos, nota fiscal, rastreio) para o caso de mediação.');
      mensagem = `Olá! Sobre o ${pedido}: queremos resolver da melhor forma. Pode nos contar o que aconteceu com ${produto}? Respondemos rapidamente.`;
  }
  if (r.aberta) {
    if (contestar) passos.push('Se você tem as provas, use "Abrir disputa / pedir mediação" na reclamação dentro do prazo: o ML analisa e pode decidir a seu favor.');
    if (acoes.has('send_message_to_complainant')) passos.unshift('Responda ao comprador pela mensagem da reclamação AGORA — resposta rápida evita a mediação.');
  } else if (r.afeta) {
    passos.push('A reclamação já foi fechada. Para pedir a revisão do impacto na reputação, fale com o Mercado Livre pela Ajuda da própria venda, anexando as provas acima.');
  }
  return { titulo, passos, mensagem };
}

function criar({ D, ml, emLotes, contaOuErro }) {
  D.db.exec(`CREATE TABLE IF NOT EXISTS rep_reclamacoes (
    claim_id INTEGER PRIMARY KEY, ml_user_id INTEGER NOT NULL, atualizada TEXT, afeta TEXT, incentivo INTEGER, prazo TEXT)`);
  const isoML = (d) => new Date(d).toISOString().replace('Z', '-00:00');

  // motivo da reclamação: texto (o mesmo cache das Devoluções) e o código (reason.name)
  async function motivo(id, conta) {
    if (!id) return { texto: null, codigo: null };
    let texto = D.configLer(`motivo_claim:${id}`), codigo = D.configLer(`motivo_claim_cod:${id}`);
    if (!codigo) {
      const r = await ml(`/post-purchase/v1/claims/reasons/${encodeURIComponent(id)}`, {}, conta).catch(() => null);
      codigo = r?.name || null; texto = texto || r?.detail || null;
      if (codigo) D.configGravar(`motivo_claim_cod:${id}`, codigo);
      if (texto) D.configGravar(`motivo_claim:${id}`, texto);
    }
    return { texto, codigo };
  }
  async function reclamacoes(conta) {
    const de = isoML(Date.now() - DIAS * 864e5);
    const lista = [];
    for (const tipo of ['mediations', 'returns']) {
      for (let off = 0; off < 1000; off += 50) {
        const r = await ml(`/post-purchase/v1/claims/search?type=${tipo}&sort=date_created:desc&range=date_created:after:${encodeURIComponent(de)}&limit=50&offset=${off}`, {}, conta);
        lista.push(...(r.data || []));
        if ((r.data || []).length < 50) break;
      }
    }
    return lista.filter((c) => (c.players || []).some((p) => p.role === 'respondent' && Number(p.user_id) === Number(conta)));
  }

  const rotas = {
    'GET /api/reputacao': async () => {
      const conta = contaOuErro();
      const id = conta.ml_user_id;
      const u = await ml(`/users/${id}`, {}, id);
      const rep = u.seller_reputation || {};
      const cls = await reclamacoes(id);
      // "afeta?" de cada reclamação: só pergunta de novo quando ela mudou (ou segue aberta)
      const cache = new Map(D.db.prepare('SELECT * FROM rep_reclamacoes WHERE ml_user_id=?').all(id).map((r) => [r.claim_id, r]));
      const perguntar = cls.filter((c) => { const x = cache.get(c.id); return !x || x.atualizada !== c.last_updated || c.status === 'opened'; });
      await emLotes(perguntar, 4, async (c) => {
        const a = await ml(`/post-purchase/v1/claims/${c.id}/affects-reputation`, {}, id).catch(() => null);
        if (!a) return;
        D.db.prepare(`INSERT OR REPLACE INTO rep_reclamacoes (claim_id, ml_user_id, atualizada, afeta, incentivo, prazo) VALUES (?,?,?,?,?,?)`)
          .run(c.id, id, c.last_updated || null, a.affects_reputation || null, a.has_incentive ? 1 : 0, a.due_date || null);
        cache.set(c.id, { afeta: a.affects_reputation, incentivo: a.has_incentive ? 1 : 0, prazo: a.due_date });
      });
      // afetaram, ou abertas (podem afetar): detalhe, produto e sugestão
      const limite = new Date(Date.now() - METRICA_DIAS * 864e5).toISOString();
      const alvo = cls.filter((c) => cache.get(c.id)?.afeta === 'affected' || c.status === 'opened');
      const pedidos = [...new Set(alvo.filter((c) => c.resource === 'order').map((c) => Number(c.resource_id)))];
      const produtos = Object.fromEntries(D.mpVendasDosPedidos(pedidos).map((r) => [r.order_id, r]));
      // título que a tabela local não tem (anúncio fora de Meus anúncios): pergunta ao ML, 20 por vez
      const semTitulo = [...new Set(Object.values(produtos).filter((p) => !p.titulo && p.item_id).map((p) => p.item_id))];
      for (let i = 0; i < semTitulo.length; i += 20) {
        const r = await ml(`/items?ids=${semTitulo.slice(i, i + 20).join(',')}&attributes=id,title`, {}, id).catch(() => []);
        for (const x of r || []) if (x.code === 200) for (const p of Object.values(produtos)) if (p.item_id === x.body.id) p.titulo = x.body.title;
      }
      const casos = await emLotes(alvo, 4, async (c) => {
        const [det, mot] = await Promise.all([ml(`/post-purchase/v1/claims/${c.id}/detail`, {}, id).catch(() => null), motivo(c.reason_id, id)]);
        const eu = (c.players || []).find((p) => Number(p.user_id) === Number(id));
        const acoes = (eu?.available_actions || []).map((a) => ({ acao: a.action, prazo: a.due_date || null, obrigatoria: !!a.mandatory }));
        const pedido = c.resource === 'order' ? Number(c.resource_id) : null;
        const prod = pedido ? produtos[pedido] : null;
        const problema = det?.problem || null;
        const categoria = categoriaDe(problema || '', mot.codigo);
        const afeta = cache.get(c.id)?.afeta === 'affected';
        const aberta = c.status === 'opened';
        return { claim_id: c.id, tipo: c.type === 'returns' ? 'Devolução' : 'Reclamação', status: c.status, etapa: c.stage,
          criada: c.date_created, na_metrica: c.date_created >= limite, afeta, aberta, incentivo: !!cache.get(c.id)?.incentivo,
          prazo_reputacao: cache.get(c.id)?.prazo || null, problema: problema || NOMES[categoria], motivo: mot.texto, motivo_codigo: mot.codigo, categoria, categoria_nome: NOMES[categoria],
          titulo_ml: det?.title || null, descricao_ml: det?.description || null, prazo: det?.due_date || null, vez_de: det?.action_responsible || null,
          resolucao: c.resolution?.reason || null, beneficiado: c.resolution?.benefited || null, acoes,
          pedido, produto: prod?.titulo || null, item_id: prod?.item_id || null,
          link: pedido ? `https://www.mercadolivre.com.br/vendas/${pedido}/detalhe` : null,
          sugestao: sugestaoDe({ categoria, afeta, aberta, acoes: acoes.map((a) => a.acao), pedido, produto: prod?.titulo }) };
      });
      // cancelamentos feitos pelo vendedor (os do comprador e da mediação do ML não pesam)
      let cancelamentos = [];
      try {
        const de = isoML(Date.now() - METRICA_DIAS * 864e5);
        for (let off = 0; off < 1000; off += 50) {
          const r = await ml(`/orders/search?seller=${id}&order.status=cancelled&order.date_created.from=${encodeURIComponent(de)}&limit=50&offset=${off}`, {}, id);
          for (const o of r.results || []) {
            const cd = o.cancel_detail || {};
            if (cd.requested_by === 'seller' || cd.group === 'seller') {
              cancelamentos.push({ pedido: o.id, data: o.date_created, motivo: cd.description || cd.code || null, produto: o.order_items?.[0]?.item?.title || null,
                link: `https://www.mercadolivre.com.br/vendas/${o.id}/detalhe` });
            }
          }
          if ((r.results || []).length < 50) break;
        }
      } catch {}
      const m = rep.metrics || {};
      const met = (k) => (m[k] ? { valor: m[k].value ?? 0, taxa: m[k].rate ?? 0, periodo: m[k].period || null } : null);
      const [nivelNome, nivelCor] = NIVEIS[rep.level_id] || [rep.level_id || 'Sem reputação', 'cinza'];
      casos.sort((a, b) => (b.aberta - a.aberta) || (b.afeta - a.afeta) || String(b.criada).localeCompare(String(a.criada)));
      return {
        conta: { ml_user_id: id, nickname: conta.nickname },
        nivel: { id: rep.level_id || null, nome: nivelNome, cor: nivelCor, lider: LIDER[rep.power_seller_status] || null },
        metricas: { vendas: m.sales ? { valor: m.sales.completed, periodo: m.sales.period } : null,
          reclamacoes: met('claims'), atrasos: met('delayed_handling_time'), cancelamentos: met('cancellations') },
        historico: rep.transactions ? { total: rep.transactions.total, concluidas: rep.transactions.completed, canceladas: rep.transactions.canceled,
          positivas: rep.transactions.ratings?.positive, negativas: rep.transactions.ratings?.negative } : null,
        afetaram: casos.filter((c) => c.afeta), em_risco: casos.filter((c) => !c.afeta && c.aberta),
        cancelamentos, reclamacoes_lidas: cls.length, dias: DIAS,
      };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, categoriaDe, sugestaoDe, NOMES };
