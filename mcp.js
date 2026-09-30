#!/usr/bin/env node
'use strict';
// npm run mcp — servidor MCP local. Dá ao Claude Code (ou a outro cliente MCP) as MESMAS
// capacidades do painel: listar anúncios, melhores produtos, curva ABC, análise por
// anúncio, publicar, editar, medir posição, e a API do Mercado Livre inteira no repasse.
//
// SEM OAuth e SEM senha: este processo roda no computador do dono, conversa por
// stdin/stdout (não abre porta nenhuma) e usa a conta que JÁ foi conectada no painel —
// os tokens cifrados no SQLite, renovados pelo mesmo `ml()` que o painel usa. Quem
// consegue rodar este arquivo já tem o banco na mão; não há fronteira nova a defender.
// A fronteira que existe continua no HTTP: sessão, origem e limite de tentativas.
//
// Cada ferramenta é uma rota do painel. Nada de lógica duplicada: o cálculo de curva ABC,
// tendência, frete real e lucro é o mesmo que a tela mostra (server.js + public/analise.js).
// Rota nova no painel vira ferramenta aqui com uma linha na tabela FERRAMENTAS.
//
// Escrita (publicar, editar, trocar tipo, custo, imposto) vem LIGADA: é o painel do dono.
// ML_MCP_ESCRITA=0 no .env deixa o servidor só de leitura — inclusive o repasse, que aí
// só aceita GET.
if (require.main === module) require('./ambiente.js').carregar(); // .env antes do db.js ler a chave
const { URL } = require('node:url');
const S = require('./server.js');

const VERSAO = '1.0.0';
// Versões do protocolo que sabemos falar, da mais nova para a mais velha. Se o cliente
// pedir uma que não está aqui, respondemos com a nossa e ele decide se continua.
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const escritaLigada = () => process.env.ML_MCP_ESCRITA !== '0';

// ---------- ferramentas ----------
// nome, o que faz, schema de entrada e para qual rota do painel vai.
// `escrita: true` = muda algo no Mercado Livre ou no banco (some com ML_MCP_ESCRITA=0).
const ITEM = { type: 'string', description: 'ID do anúncio, ex.: MLB1234567890' };
const DIAS = { type: 'integer', enum: [15, 30, 60, 90, 150], default: 30,
  description: 'Janela em dias (padrão 30). O ML só entrega série diária de visitas até 150 dias.' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const qs = (pares) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(pares)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const FERRAMENTAS = [
  // ----- contas -----
  { nome: 'ml_contas', titulo: 'Contas conectadas',
    descricao: 'Contas do Mercado Livre já conectadas no painel e qual está ativa. Nunca devolve token.',
    schema: obj({}),
    rota: () => ['GET', '/api/accounts'] },

  { nome: 'ml_conta_usar', titulo: 'Trocar a conta ativa', escrita: true,
    descricao: 'Escolhe em qual conta conectada as outras ferramentas vão trabalhar.',
    schema: obj({ ml_user_id: { type: 'integer', description: 'ID do vendedor, como aparece em ml_contas' } }, ['ml_user_id']),
    rota: (a) => ['POST', '/api/accounts/active', { ml_user_id: a.ml_user_id }] },

  // ----- listagem, melhores produtos e curva ABC -----
  { nome: 'ml_anuncios', titulo: 'Listar anúncios',
    descricao: 'Lista os anúncios da conta ativa com visitas e tendência do período. '
      + 'Para MELHORES PRODUTOS use sort=vendas_desc; para CURVA ABC, sort=abc (A/B/C por '
      + 'faturamento na conta inteira); para quem está caindo, sort=queda; margem_desc/margem_asc '
      + 'ordenam pela rentabilidade do período; pausados põe os pausados primeiro e sem_venda_90 '
      + 'mostra só quem não vendeu em 90 dias. Esses ordenam pelos pedidos baixados do ML, não '
      + 'pelo total de sempre. Máximo de 20 por página.',
    schema: obj({
      status: { type: 'string', enum: ['active', 'paused', 'closed', 'under_review'] },
      q: { type: 'string', description: 'Filtra por texto no título' },
      sort: { type: 'string',
        enum: ['vendas_desc', 'vendas_asc', 'abc', 'queda', 'margem_desc', 'margem_asc', 'pausados', 'sem_venda_90',
          'last_updated_desc', 'last_updated_asc',
          'price_asc', 'price_desc', 'sold_quantity_desc', 'sold_quantity_asc',
          'available_quantity_asc', 'available_quantity_desc', 'start_time_desc', 'start_time_asc',
          'stop_time_desc', 'stop_time_asc'],
        description: 'Padrão: last_updated_desc.' },
      dias: DIAS,
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
    }),
    rota: (a) => ['GET', `/api/items${qs({ status: a.status, q: a.q, sort: a.sort, dias: a.dias, offset: a.offset, limit: a.limit })}`] },

  { nome: 'ml_periodo', titulo: 'Vendas, curva ABC e lucro do período',
    descricao: 'Para até 50 anúncios: unidades, pedidos, faturamento, tarifas, letra da curva ABC, '
      + 'tendência, frete real medido e lucro/margem quando há custo cadastrado. Traz também o '
      + 'total da conta no período. É o que a tela "Meus anúncios" mostra.',
    schema: obj({
      ids: { type: 'array', items: ITEM, maxItems: 50, description: 'IDs dos anúncios (até 50)' },
      dias: DIAS,
    }, ['ids']),
    rota: (a) => ['GET', `/api/periodo${qs({ dias: a.dias, ids: (a.ids || []).join(',') })}`] },

  { nome: 'ml_anuncio', titulo: 'Ver um anúncio',
    descricao: 'Anúncio completo, com descrição, visitas de 30 dias e os avisos de travas '
      + '(família e variações travam título, preço e estoque).',
    schema: obj({ id: ITEM }, ['id']),
    rota: (a) => ['GET', `/api/items/${a.id}`] },

  { nome: 'ml_analise', titulo: 'Análise de um anúncio',
    descricao: 'Painel do anúncio numa janela: visitas dia a dia com pico e tendência, vendas, '
      + 'ticket médio, conversão, perguntas, avaliações, concorrência de categoria, tarifas, '
      + 'frete por unidade e lucro. Visitas e vendas na MESMA janela.',
    schema: obj({ id: ITEM, dias: DIAS }, ['id']),
    rota: (a) => ['GET', `/api/items/${a.id}/analytics${qs({ dias: a.dias })}`] },

  { nome: 'ml_qualidade', titulo: 'Qualidade do anúncio',
    descricao: 'Health do anúncio e o que o próprio Mercado Livre sugere melhorar.',
    schema: obj({ id: ITEM }, ['id']),
    rota: (a) => ['GET', `/api/items/${a.id}/quality`] },

  { nome: 'ml_upgrades', titulo: 'Trocas de tipo disponíveis',
    descricao: 'Tipos de anúncio (clássico, premium...) para os quais este anúncio pode mudar.',
    schema: obj({ id: ITEM }, ['id']),
    rota: (a) => ['GET', `/api/items/${a.id}/upgrades`] },

  // ----- posição na busca (scraper local) -----
  { nome: 'ml_posicao', titulo: 'Medir posição na busca', escrita: true,
    descricao: 'Mede AGORA em que posição o anúncio aparece na busca do termo e grava no '
      + 'histórico. Usa o scraper (navegador logado): leva ~3 s por página e exige o scraper no ar.',
    schema: obj({ item: ITEM, termo: { type: 'string', minLength: 2, maxLength: 80 },
      paginas: { type: 'integer', minimum: 1, maximum: 3, default: 1 } }, ['item', 'termo']),
    rota: (a) => ['POST', '/api/posicao', { item: a.item, termo: a.termo, paginas: a.paginas }] },

  { nome: 'ml_termos', titulo: 'Termos acompanhados',
    descricao: 'Lista os termos de busca acompanhados de um anúncio, com o histórico de posição.',
    schema: obj({ item: ITEM }, ['item']),
    rota: (a) => ['GET', `/api/keywords${qs({ item: a.item })}`] },

  { nome: 'ml_termo_add', titulo: 'Acompanhar um termo', escrita: true,
    descricao: 'Passa a acompanhar um termo de busca para um anúncio.',
    schema: obj({ item: ITEM, termo: { type: 'string', minLength: 2, maxLength: 80 } }, ['item', 'termo']),
    rota: (a) => ['POST', '/api/keywords', { item: a.item, termo: a.termo }] },

  { nome: 'ml_termo_remover', titulo: 'Parar de acompanhar um termo', escrita: true,
    descricao: 'Tira um termo de busca do acompanhamento de um anúncio.',
    schema: obj({ item: ITEM, termo: { type: 'string' } }, ['item', 'termo']),
    rota: (a) => ['POST', '/api/keywords/remove', { item: a.item, termo: a.termo }] },

  // ----- publicar e editar -----
  { nome: 'ml_publicar', titulo: 'Publicar anúncio', escrita: true,
    descricao: 'Publica um anúncio novo. Mesmos campos da tela Publicar: title, category_id, '
      + 'price, quantity, condition, listing_type_id, description, pictures/picture_ids, '
      + 'attributes (objeto id→valor), free_shipping, sale_terms. Se o ML recusar por campo '
      + 'faltando, a resposta diz quais em "faltando". Confira a categoria com ml_categoria antes.',
    schema: { type: 'object', description: 'Campos do anúncio (os mesmos da tela Publicar).',
      properties: { title: { type: 'string' }, category_id: { type: 'string' },
        price: { type: ['number', 'string'] }, quantity: { type: ['integer', 'string'] },
        condition: { type: 'string', enum: ['new', 'used', 'not_specified'] },
        listing_type_id: { type: 'string' }, description: { type: 'string' },
        pictures: { type: ['array', 'string'], items: { type: 'string' } },
        picture_ids: { type: 'array', items: { type: 'string' } },
        attributes: { type: 'object' }, sale_terms: { type: 'object' },
        free_shipping: { type: 'boolean' } },
      required: ['title', 'category_id', 'price', 'quantity'] },
    rota: (a) => ['POST', '/api/items', a] },

  { nome: 'ml_editar', titulo: 'Editar anúncio', escrita: true,
    descricao: 'Edita um anúncio existente: preço, estoque, título, fotos, ficha técnica. '
      + 'O ML tem travas medidas: com family_name o título não muda, e com variações preço e '
      + 'estoque vivem na variação. Tipo de anúncio tem ferramenta própria (ml_trocar_tipo).',
    schema: { type: 'object',
      properties: { id: ITEM, title: { type: 'string' }, price: { type: ['number', 'string'] },
        available_quantity: { type: ['integer', 'string'] }, status: { type: 'string', enum: ['active', 'paused', 'closed'] },
        pictures: { type: 'array', items: { type: 'string' } }, picture_ids: { type: 'array', items: { type: 'string' } },
        attributes: { type: 'object' }, sale_terms: { type: 'object' }, variations: { type: 'array' } },
      required: ['id'] },
    rota: (a) => { const { id, ...resto } = a; return ['PUT', `/api/items/${id}`, resto]; } },

  { nome: 'ml_editar_descricao', titulo: 'Trocar a descrição', escrita: true,
    descricao: 'Substitui a descrição do anúncio (texto puro).',
    schema: obj({ id: ITEM, texto: { type: 'string', minLength: 1 } }, ['id', 'texto']),
    rota: (a) => ['PUT', `/api/items/${a.id}/description`, { plain_text: a.texto }] },

  { nome: 'ml_trocar_tipo', titulo: 'Trocar o tipo do anúncio', escrita: true,
    descricao: 'Muda o tipo do anúncio (ex.: gold_special → gold_pro). Veja as opções em ml_upgrades. '
      + 'Muda a tarifa que o ML cobra: confirme com o dono antes.',
    schema: obj({ id: ITEM, listing_type_id: { type: 'string' } }, ['id', 'listing_type_id']),
    rota: (a) => ['POST', `/api/items/${a.id}/listing-type`, { listing_type_id: a.listing_type_id }] },

  // ----- custos (entram no lucro) -----
  { nome: 'ml_custo', titulo: 'Gravar custo do produto', escrita: true,
    descricao: 'Custo do produto e outros custos por unidade. É o que falta para o painel '
      + 'calcular lucro e margem. Fica só no computador — não vai para o Mercado Livre.',
    schema: obj({ id: ITEM, custo: { type: ['number', 'null'] }, outros: { type: ['number', 'null'] } }, ['id']),
    rota: (a) => ['PUT', `/api/items/${a.id}/custo`, { custo: a.custo, outros: a.outros }] },

  { nome: 'ml_imposto', titulo: 'Imposto sobre a venda', escrita: true,
    descricao: 'Percentual de imposto sobre o faturamento, da conta inteira (0 a 99). Entra no lucro.',
    schema: obj({ pct: { type: ['number', 'null'], minimum: 0, maximum: 99 } }, ['pct']),
    rota: (a) => ['PUT', '/api/imposto', { pct: a.pct }] },

  // ----- apoio ao cadastro -----
  { nome: 'ml_prever_categoria', titulo: 'Sugerir categoria',
    descricao: 'Sugere categorias do Mercado Livre a partir de um título.',
    schema: obj({ q: { type: 'string', minLength: 2 } }, ['q']),
    rota: (a) => ['GET', `/api/predict${qs({ q: a.q })}`] },

  { nome: 'ml_categoria', titulo: 'Ficha técnica da categoria',
    descricao: 'Campos obrigatórios, opcionais e regras da categoria — inclusive quando ela exige '
      + 'tabela de medidas (roupas e calçados).',
    schema: obj({ id: { type: 'string', description: 'ID da categoria, ex.: MLB31447' } }, ['id']),
    rota: (a) => ['GET', `/api/category${qs({ id: a.id })}`] },

  { nome: 'ml_tipos_anuncio', titulo: 'Tipos de anúncio do site',
    descricao: 'Tipos de anúncio disponíveis no site da conta (clássico, premium...).',
    schema: obj({}),
    rota: () => ['GET', '/api/listing-types'] },

  // ----- estado do sistema -----
  { nome: 'ml_config', titulo: 'Situação do painel',
    descricao: 'Túnel, endereço público, o que o aplicativo tem cadastrado no Mercado Livre, '
      + 'estado do scraper e o que ainda falta configurar. Não devolve a chave secreta.',
    schema: obj({ forcar: { type: 'boolean', description: 'true relê o cadastro no ML (mais lento)' } }),
    rota: (a) => ['GET', `/api/config${qs({ forcar: a.forcar ? '1' : '' })}`] },

  { nome: 'ml_scraper', titulo: 'Estado do scraper',
    descricao: 'O scraper (navegador logado) está no ar e com a sessão do Mercado Livre válida?',
    schema: obj({}),
    rota: () => ['GET', '/api/scraper'] },

  { nome: 'ml_notificacoes', titulo: 'Notificações recebidas',
    descricao: 'Últimas notificações que o Mercado Livre mandou para o webhook.',
    schema: obj({}),
    rota: () => ['GET', '/api/notifications'] },

  { nome: 'ml_ads', titulo: 'Mercado Ads',
    descricao: 'A conta tem anunciante no Mercado Ads? Devolve os advertisers quando tem.',
    schema: obj({}),
    rota: () => ['GET', '/api/ads/status'] },

  // ----- promoções -----
  { nome: 'ml_promocoes', titulo: 'Promoções disponíveis',
    descricao: 'Promoções abertas para a conta agora (campanhas do ML, ofertas cofinanciadas, '
      + 'relâmpago, desconto no Pix…), com quantos anúncios participam, estão programados e podem entrar.',
    schema: obj({}),
    rota: () => ['GET', '/api/promocoes'] },

  { nome: 'ml_promocao_itens', titulo: 'Anúncios de uma promoção',
    descricao: 'Anúncios de uma promoção, com preço atual, promocional, quem paga o desconto e a '
      + 'oferta (offer_id) para aderir. Pagina de 50 em 50 com "depois".',
    schema: obj({
      promocao: { type: 'string', description: 'id da promoção, ex.: P-MLB18061082 (de ml_promocoes)' },
      tipo: { type: 'string', description: 'tipo da promoção, ex.: DEAL, SMART, LIGHTNING' },
      status: { type: 'string', enum: ['candidate', 'started', 'pending'],
        description: 'candidate = pode entrar; started = participando; pending = programado' },
      depois: { type: 'string', description: 'cursor "depois" da página anterior' },
    }, ['promocao', 'tipo']),
    rota: (a) => ['GET', `/api/promocoes/itens${qs({ promocao: a.promocao, tipo: a.tipo, status: a.status, depois: a.depois })}`] },

  { nome: 'ml_promocoes_anuncio', titulo: 'Promoções de um anúncio',
    descricao: 'Todas as promoções de um anúncio e a situação dele em cada uma (pode entrar, '
      + 'participando, programado), com os limites de preço e a oferta para aderir.',
    schema: obj({ id: ITEM }, ['id']),
    rota: (a) => ['GET', `/api/promocoes/anuncio/${a.id}`] },

  { nome: 'ml_promocoes_por_anuncio', titulo: 'Promoções agrupadas por anúncio',
    descricao: 'Anúncios que estão ou podem entrar em promoções, cada um com todas as promoções dele '
      + '(situação, preço promocional, quem paga o desconto). 20 por página, ordenados pelas vendas de 90 dias.',
    schema: obj({
      q: { type: 'string', description: 'título ou código MLB' },
      filtro: { type: 'string', enum: ['participando', 'podem_entrar', 'fora'] },
      promocao: { type: 'string', description: 'id da promoção (de ml_promocoes)' },
      pagina: { type: 'integer', minimum: 0, default: 0 },
    }),
    rota: (a) => ['GET', `/api/promocoes/por-anuncio${qs({ q: a.q, filtro: a.filtro, promocao: a.promocao, pagina: a.pagina })}`] },

  { nome: 'ml_promocao_aderir', titulo: 'Colocar anúncio numa promoção', escrita: true,
    descricao: 'Coloca o anúncio na promoção. MUDA O PREÇO DE VENDA de verdade: confirme com o '
      + 'dono antes. DEAL, SELLER_CAMPAIGN, DOD e LIGHTNING pedem preco; LIGHTNING pede estoque; '
      + 'SMART e PRICE_MATCHING pedem oferta_id (de ml_promocoes_anuncio); PRICE_DISCOUNT pede '
      + 'preco, inicio e fim e não tem promocao_id.',
    schema: obj({
      id: ITEM,
      promocao_id: { type: 'string' },
      tipo: { type: 'string' },
      oferta_id: { type: 'string' },
      preco: { type: 'number', description: 'preço promocional em reais' },
      estoque: { type: 'integer', description: 'unidades na oferta relâmpago' },
      inicio: { type: 'string', description: 'ISO, só PRICE_DISCOUNT' },
      fim: { type: 'string', description: 'ISO, só PRICE_DISCOUNT' },
    }, ['id', 'tipo']),
    rota: ({ id, ...corpo }) => ['POST', `/api/promocoes/anuncio/${id}/aderir`, corpo] },

  { nome: 'ml_promocao_sair', titulo: 'Tirar anúncio de uma promoção', escrita: true,
    descricao: 'Tira o anúncio da promoção; o preço volta ao original. Confirme com o dono antes.',
    schema: obj({
      id: ITEM,
      promocao_id: { type: 'string' },
      tipo: { type: 'string' },
      oferta_id: { type: 'string', description: 'obrigatório em SMART e PRICE_MATCHING' },
    }, ['id', 'tipo']),
    rota: ({ id, ...corpo }) => ['POST', `/api/promocoes/anuncio/${id}/sair`, corpo] },

  { nome: 'ml_promocoes_resultado', titulo: 'Vendas por promoção',
    descricao: 'Quanto cada promoção vendeu no período (pedidos, unidades, faturamento, desconto '
      + 'pago pelo vendedor e pelo ML, retorno por real de desconto), comparado com as vendas sem '
      + 'promoção, e os anúncios que mais venderam em cada uma.',
    schema: obj({ dias: { type: 'integer', enum: [7, 15, 30, 60, 90], default: 30 } }),
    rota: (a) => ['GET', `/api/promocoes/resultado${qs({ dias: a.dias })}`] },

  // ----- devoluções -----
  { nome: 'ml_devolucoes', titulo: 'Devoluções e reclamações',
    descricao: 'Devoluções e reclamações do período: valor devolvido ao comprador, custo de cada uma (frete de ida '
      + 'perdido, frete de volta cobrado, produto não devolvido), motivos, cobertura do ML, '
      + 'as que esperam ação do vendedor e a taxa de devolução por anúncio.',
    schema: obj({ dias: { type: 'integer', enum: [7, 15, 30, 60, 90, 180], default: 30 } }),
    rota: (a) => ['GET', `/api/devolucoes${qs({ dias: a.dias })}`] },

  // ----- vendas, custos e empresa -----
  { nome: 'ml_vendas', titulo: 'Vendas com lucro e margem',
    descricao: 'Todas as vendas do período, uma por linha, com tarifa, frete, imposto, custo do produto '
      + '(pelo SKU), embalagem, lucro e margem; o resumo do período e os anúncios vendidos sem custo.',
    schema: obj({ dias: { type: 'integer', enum: [1, 7, 15, 30, 60, 90], default: 30, description: '1 = hoje' } }),
    rota: (a) => ['GET', `/api/vendas${qs({ dias: a.dias })}`] },

  { nome: 'ml_custos_anuncios', titulo: 'Custo de cada anúncio',
    descricao: 'Custo do produto de cada anúncio calculado pelo SKU (KIT-407.408 = produto 407 + 408), '
      + 'embalagem e o alerta dos anúncios sem custo.',
    schema: obj({}),
    rota: () => ['GET', '/api/custos-anuncios'] },

  // ----- acompanhamento -----
  { nome: 'ml_dashboard', titulo: 'Resumo do painel',
    descricao: 'Hoje e últimos 30 dias: faturamento, lucro e margem; resultado das devoluções; '
      + 'investimento e ROAS do Mercado Ads; vendas e estoque do Full.',
    schema: obj({}),
    rota: () => ['GET', '/api/dashboard/resumo'] },

  { nome: 'ml_performance', titulo: 'Performance do período',
    descricao: 'Faturamento, pedidos, ticket, visitas, conversão, tarifas e cancelamentos do período contra '
      + 'o período anterior, série diária e os anúncios que mais cresceram e mais caíram.',
    schema: obj({ dias: { type: 'integer', enum: [7, 15, 30, 60], default: 30 } }),
    rota: (a) => ['GET', `/api/performance${qs({ dias: a.dias })}`] },

  { nome: 'ml_performance_envios', titulo: 'Vendas por tipo de envio',
    descricao: 'Quantas vendas e quanto faturou cada tipo de envio no período: Full, Flex e Mercado Envios '
      + '(coleta ou agência). envios_pendentes > 0 = ainda lendo o tipo de alguns envios: chame de novo.',
    schema: obj({ dias: { type: 'integer', enum: [7, 15, 30, 60], default: 30 } }),
    rota: (a) => ['GET', `/api/performance/logistica${qs({ dias: a.dias })}`] },

  { nome: 'ml_abc', titulo: 'Curva ABC com lucro',
    descricao: 'Curva ABC pelo faturamento (A = 80%, B = 15%, C = 5%) com participação, acumulado, '
      + 'unidades, lucro e margem de cada anúncio, e o resumo por classe.',
    schema: obj({ dias: { type: 'integer', enum: [15, 30, 60, 90, 150], default: 30 } }),
    rota: (a) => ['GET', `/api/abc${qs({ dias: a.dias })}`] },

  { nome: 'ml_ads_historico', titulo: 'Histórico do Mercado Ads',
    descricao: 'Investimento, receita, ROAS, ACOS, cliques e unidades do Mercado Ads dia a dia, e por campanha. '
      + 'Com campanha (id), a série é só dela. Traz também "mudancas": o que mudou nas campanhas no período '
      + '(ROAS objetivo, orçamento diário, situação), registrado pelo painel desde "mudancas_desde".',
    schema: obj({ dias: { type: 'integer', minimum: 7, maximum: 90, default: 30 },
      campanha: { type: 'integer', description: 'id da campanha (de "campanhas")' } }),
    rota: (a) => ['GET', `/api/ads/historico${qs({ dias: a.dias, campanha: a.campanha })}`] },

  { nome: 'ml_ads_comparativo', titulo: 'Comparativo do Mercado Ads',
    descricao: 'Mercado Ads nos últimos 7, 15, 30, 60 e 90 dias: investimento, vendas, ROAS e ACOS de cada '
      + 'período, a média por dia e a variação contra o período de mesmo tamanho logo antes. Mostra se o '
      + 'Ads está crescendo ou diminuindo.',
    schema: obj({ campanha: { type: 'integer', description: 'id da campanha; sem ele, a conta inteira' } }),
    rota: (a) => ['GET', `/api/ads/comparativo${qs({ campanha: a.campanha })}`] },

  { nome: 'ml_full', titulo: 'Estoque e vendas do Full',
    descricao: 'Anúncios no Full com estoque no armazém do ML e no depósito, vendas que saíram do Full '
      + '(30/60/90 dias), média diária e para quantos dias o estoque do Full dá.',
    schema: obj({}),
    rota: () => ['GET', '/api/full'] },

  { nome: 'ml_qualidade_anuncios', titulo: 'Qualidade dos anúncios',
    descricao: 'Nota de qualidade do ML (0-100) dos anúncios ativos e os objetivos pendentes. '
      + 'filtro: incompletos (ficha, fotos, GTIN…), ruins (nota < 70) ou objetivos (qualquer pendência).',
    schema: obj({ filtro: { type: 'string', enum: ['incompletos', 'ruins', 'objetivos'] },
      pagina: { type: 'integer', minimum: 0, default: 0 } }),
    rota: (a) => ['GET', `/api/anuncios/qualidade${qs({ filtro: a.filtro, pagina: a.pagina })}`] },

  { nome: 'ml_avisos', titulo: 'Avisos do painel',
    descricao: 'Vendas novas, mensagens de comprador e anúncios pausados (sem estoque ou pelo ML).',
    schema: obj({}),
    rota: () => ['GET', '/api/avisos'] },

  { nome: 'ml_devolucao_defeito', titulo: 'Marcar devolução com defeito', escrita: true,
    descricao: 'Marca (true) ou desmarca (false) o produto devolvido como com defeito. Só a peça com '
      + 'defeito entra no custo das devoluções. Em kit, passe produtos = posições (começando em 0) das '
      + 'peças com defeito na lista "componentes" da reclamação em ml_devolucoes; só elas somam. '
      + 'Não muda nada no Mercado Livre.',
    schema: obj({ reclamacao: { type: 'integer', description: 'id da reclamação (de ml_devolucoes)' },
      defeito: { type: 'boolean' },
      produtos: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Kit: posições das peças com defeito' } },
    ['reclamacao']),
    rota: (a) => ['PUT', `/api/devolucoes/${a.reclamacao}/defeito`, a.produtos ? { produtos: a.produtos } : { defeito: a.defeito }] },

  { nome: 'ml_status_em_massa', titulo: 'Pausar ou reativar em massa', escrita: true,
    descricao: 'Pausa (paused) ou reativa (active) vários anúncios de uma vez no Mercado Livre — até 300 por '
      + 'chamada. Devolve quantos mudaram e, dos que não mudaram, o motivo. CONFIRME a lista com o usuário antes.',
    schema: obj({ status: { type: 'string', enum: ['paused', 'active'] },
      ids: { type: 'array', items: ITEM, minItems: 1, maxItems: 300 } }, ['status', 'ids']),
    rota: (a) => ['POST', '/api/items/status-em-massa', { status: a.status, ids: a.ids }] },

  { nome: 'ml_produto_anuncios', titulo: 'Anúncios que usam um produto',
    descricao: 'Anúncios que têm o produto da tabela (pelo número: 795 = DD-795) no SKU, com o SKU de cada um. '
      + 'Use antes de ml_produto_trocar_sku para escolher em quais trocar.',
    schema: obj({ produto: { type: 'integer', description: 'Número do produto na tabela (DD-795 -> 795)' } }, ['produto']),
    rota: (a) => ['GET', `/api/produtos/${a.produto}/anuncios`] },

  { nome: 'ml_produto_trocar_sku', titulo: 'Trocar produto no SKU dos anúncios', escrita: true,
    descricao: 'Troca um produto por outro dentro do SKU dos anúncios escolhidos, no Mercado Livre: com '
      + 'produto=795 e novo=854, "KIT-795.713" vira "KIT-854.713" (o resto do SKU não muda). Até 200 anúncios '
      + 'por chamada. Cadastre o produto novo na tabela antes, senão os anúncios ficam sem custo. CONFIRME '
      + 'a lista com o usuário antes.',
    schema: obj({ produto: { type: 'integer', description: 'Número do produto atual (795)' },
      novo: { type: 'string', description: 'SKU ou número do produto novo (DD-854 ou 854)' },
      ids: { type: 'array', items: ITEM, minItems: 1, maxItems: 200 } }, ['produto', 'novo', 'ids']),
    rota: (a) => ['POST', `/api/produtos/${a.produto}/trocar-sku`, { novo: a.novo, ids: a.ids }] },

  { nome: 'ml_custo_anuncio', titulo: 'Embalagem e outro custo do anúncio', escrita: true,
    descricao: 'Grava o custo de embalagem e/ou outro custo por unidade do anúncio (etiqueta, brinde…), '
      + 'descontados do lucro. null apaga: a embalagem volta à padrão da empresa. Só no painel: não muda nada no ML.',
    schema: obj({ id: ITEM, embalagem: { type: ['number', 'null'] }, outro_custo: { type: ['number', 'null'] } }, ['id']),
    rota: (a) => ['PUT', `/api/custos-anuncios/${a.id}`, {
      ...('embalagem' in a ? { embalagem: a.embalagem } : {}), ...('outro_custo' in a ? { outro_custo: a.outro_custo } : {}) }] },

  { nome: 'ml_campanha_criar', titulo: 'Criar campanha do vendedor', escrita: true,
    descricao: 'Cria uma campanha de desconto do vendedor no Mercado Livre (até 14 dias, início a partir '
      + 'de hoje). Os anúncios entram depois com ml_promocao_aderir (tipo SELLER_CAMPAIGN, com preço). '
      + 'Confirme com o dono antes.',
    schema: obj({ nome: { type: 'string' }, inicio: { type: 'string', description: 'AAAA-MM-DD' },
      fim: { type: 'string', description: 'AAAA-MM-DD' } }, ['nome', 'inicio', 'fim']),
    rota: (a) => ['POST', '/api/promocoes/campanha', { nome: a.nome, inicio: a.inicio, fim: a.fim }] },

  { nome: 'ml_produtos', titulo: 'Tabela de produtos',
    descricao: 'Produtos (componentes dos kits) com custo, situação, fornecedor, quantos anúncios usam '
      + 'cada um e o estoque desses anúncios no Mercado Livre.',
    schema: obj({}),
    rota: () => ['GET', '/api/produtos'] },

  { nome: 'ml_empresa', titulo: 'Dados da empresa e impostos',
    descricao: 'Razão social, regime, impostos (% do faturamento) e o resumo da tabela de produtos.',
    schema: obj({}),
    rota: () => ['GET', '/api/empresa'] },

  // ----- a API inteira -----
  // Única ferramenta que não some com ML_MCP_ESCRITA=0: ela é a API inteira, e ler a API
  // inteira é leitura. Quem bloqueia POST/PUT/DELETE ali é o próprio repasse.
  { nome: 'ml_api', titulo: 'Chamar a API do Mercado Livre', escritaOpcional: true,
    descricao: 'Repasse direto para api.mercadolibre.com com o token da conta ativa (renovado '
      + 'sozinho). Use para o que não tem ferramenta própria: /users/me, /orders/search, '
      + '/questions/search, /shipments/{id}, /trends/{site}/{cat}... GET não muda nada; '
      + 'POST, PUT e DELETE mudam a conta de verdade. Com ML_MCP_ESCRITA=0 só GET passa.',
    schema: obj({
      caminho: { type: 'string', description: 'Caminho na API, começando com "/". Ex.: /users/me' },
      metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
      corpo: { type: 'object', description: 'Corpo JSON, para POST e PUT' },
      api_version: { type: 'string', description: 'Header api-version (o Mercado Ads pede "2")' },
    }, ['caminho']),
    direta: true },
];

// ---------- ponte com o painel ----------
const BASE = 'http://painel.local';

async function chamarFerramenta(f, args) {
  if (f.direta) return repasseML(args);
  const [metodo, caminho, corpo] = f.rota(args);
  return S.despachar(metodo, new URL(BASE + caminho), corpo || {});
}

// O repasse NÃO é uma rota do painel: chama a API do ML direto, com o token da conta ativa
// e a renovação automática do `ml()`. Ele existe só aqui porque rota HTTP de repasse, pela
// porta pública, viraria "faça qualquer coisa na conta do vendedor" para quem achasse a URL.
async function repasseML(args) {
  const caminho = String(args.caminho || '').trim();
  if (!caminho.startsWith('/')) {
    throw Object.assign(new Error('O caminho precisa começar com "/". Ex.: /users/me'), { status: 400 });
  }
  const metodo = String(args.metodo || 'GET').toUpperCase();
  if (metodo !== 'GET' && !escritaLigada()) {
    throw Object.assign(new Error(`${metodo} está desligado (ML_MCP_ESCRITA=0 no .env). Só GET passa.`), { status: 403 });
  }
  const opts = { method: metodo };
  if (args.corpo !== undefined && (metodo === 'POST' || metodo === 'PUT')) opts.body = JSON.stringify(args.corpo);
  if (args.api_version) opts.headers = { 'api-version': String(args.api_version) };
  return S.ml(caminho, opts);
}

// ---------- protocolo MCP (JSON-RPC 2.0 por stdio) ----------
const LIMITE_TEXTO = 400_000; // acima disso o cliente sofre para ler; corta e avisa.

const texto = (dados) => {
  let t = typeof dados === 'string' ? dados : JSON.stringify(dados, null, 2);
  if (t.length > LIMITE_TEXTO) t = `${t.slice(0, LIMITE_TEXTO)}\n\n… resposta cortada em ${LIMITE_TEXTO} caracteres. Peça menos itens (limit/ids) ou um caminho mais específico.`;
  return { content: [{ type: 'text', text: t }] };
};
const erro = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

const ferramentasVisiveis = () => FERRAMENTAS.filter((f) => escritaLigada() || !f.escrita);

const descrever = (f) => {
  // ml_api só escreve quando a escrita está ligada; desligada, ela é leitura pura.
  const muda = !!f.escrita || (f.escritaOpcional && escritaLigada());
  return {
    name: f.nome,
    title: f.titulo,
    description: f.descricao,
    inputSchema: f.schema,
    annotations: { title: f.titulo, readOnlyHint: !muda, destructiveHint: !!muda, openWorldHint: true },
  };
};

async function tratar(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const pedida = params.protocolVersion;
      return { protocolVersion: PROTOCOLOS.includes(pedida) ? pedida : PROTOCOLOS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'HN-Gestor-ML', title: 'Mercado Livre (painel da aula)', version: VERSAO },
        instructions: 'Ferramentas do painel do Mercado Livre deste computador, na conta já conectada. '
          + 'Comece por ml_contas; para "melhores produtos" use ml_anuncios com sort=vendas_desc e '
          + 'para a curva ABC sort=abc; ml_periodo traz faturamento, lucro e ABC de vários anúncios de '
          + 'uma vez. O que não tem ferramenta própria passa por ml_api.' };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: ferramentasVisiveis().map(descrever) };
    case 'tools/call': {
      const f = ferramentasVisiveis().find((x) => x.nome === params.name);
      if (!f) {
        const escondida = FERRAMENTAS.some((x) => x.nome === params.name);
        return erro(escondida
          ? `A ferramenta "${params.name}" muda dados e está desligada (ML_MCP_ESCRITA=0 no .env).`
          : `Ferramenta desconhecida: ${params.name}`);
      }
      try {
        return texto(await chamarFerramenta(f, params.arguments || {}));
      } catch (e) {
        // Erro de ferramenta volta como resultado (isError), não como erro de protocolo:
        // assim o modelo lê a mensagem do ML e corrige, em vez de a chamada "sumir".
        const detalhe = e.faltando ? `\nCampos que o ML pediu: ${JSON.stringify(e.faltando)}`
          : (e.body?.cause ? `\nDetalhe: ${JSON.stringify(e.body.cause)}` : '');
        return erro(`${e.message}${detalhe}`);
      }
    }
    default:
      if (method?.startsWith('notifications/')) return null; // notificação: não se responde
      throw Object.assign(new Error(`método não suportado: ${method}`), { codigo: -32601 });
  }
}

// ---------- transporte stdio ----------
// Mensagens são JSON numa linha só. NADA além delas pode sair no stdout — log vai no stderr.
const escrever = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (...a) => process.stderr.write(`[mcp] ${a.join(' ')}\n`);

// Chamadas em andamento. Uma ferramenta pode estar esperando o Mercado Livre quando o
// cliente fecha o stdin; sair na hora engoliria a resposta que já foi pedida.
let pendentes = 0;
let fechando = false;
const talvezSair = () => { if (fechando && pendentes === 0) process.exit(0); };

async function linha(txt) {
  let msg;
  try { msg = JSON.parse(txt); } catch {
    return escrever({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  const ehNotificacao = msg.id === undefined || msg.id === null;
  pendentes++;
  try {
    const r = await tratar(msg);
    if (!ehNotificacao) escrever({ jsonrpc: '2.0', id: msg.id, result: r ?? {} });
  } catch (e) {
    if (!ehNotificacao) escrever({ jsonrpc: '2.0', id: msg.id, error: { code: e.codigo || -32603, message: e.message } });
    else log('erro em notificação:', e.message);
  } finally {
    pendentes--;
    talvezSair();
  }
}

function iniciar() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (pedaco) => {
    buffer += pedaco;
    let quebra;
    while ((quebra = buffer.indexOf('\n')) >= 0) {
      const t = buffer.slice(0, quebra).trim();
      buffer = buffer.slice(quebra + 1);
      if (t) linha(t).catch((e) => log('falha ao tratar linha:', e.message));
    }
  });
  // Cliente fechou a conversa: responde o que já estava no ar e sai. Sem isso, uma chamada
  // esperando o Mercado Livre morria sem resposta quando o cliente encerrava.
  process.stdin.on('end', () => {
    fechando = true;
    setTimeout(() => process.exit(0), 30000).unref(); // teto: não ficar preso numa chamada travada
    talvezSair();
  });
  log(`pronto — ${ferramentasVisiveis().length} ferramentas`
    + `${escritaLigada() ? '' : ' (só leitura: ML_MCP_ESCRITA=0)'}`);
}

if (require.main === module) iniciar();
module.exports = { FERRAMENTAS, tratar, chamarFerramenta };
