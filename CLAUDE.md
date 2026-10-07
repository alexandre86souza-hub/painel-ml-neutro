# Aula Mercado Livre - Henrique Niada

Responda em português do Brasil. Instalação do zero: siga `PRD-INSTALACAO.md`.

## Rodar

- `npm run setup` — instala tudo (uv, Python, Chromium) e roda os testes. Idempotente.
- `npm start` — sobe painel (`localhost:3100`), scraper Python (`127.0.0.1:8100`) e túnel
  HTTPS juntos. Processo longo: rode em segundo plano. `Ctrl+C` encerra painel e scraper e
  deixa o túnel aberto (a URL não muda no próximo `npm start`). `npm run parar` fecha tudo.
  Ao reiniciar para aplicar mudança de código, NÃO use `npm run parar`: a URL mudaria.
- `npm run atualizar` — traz as correções do repositório da aula (fork não recebe sozinho).
- `npm run mcp` — servidor MCP por stdio (só para depurar; o Claude Code sobe sozinho pelo
  `.mcp.json` de quem abre esta pasta). Confira com `/mcp`.
- `npm run backup` — cópia de segurança do banco agora (`-- --pasta "C:..."` grava a pasta, ex.: OneDrive).
  O painel também copia sozinho 1x/dia (`backup.js`, ligado por iniciar.js). `npm run restaurar -- <arquivo>`
  volta uma cópia com o painel PARADO (o banco atual fica ao lado). A ML_DB_KEY do .env não vai na cópia.
- `npm test` — testes do painel. Scraper: `cd scraper && uv run python test_api.py`.
- Logs: `logs/scraper.log`, `logs/tunel.log`.

## Arquitetura (leia antes de mexer)

- `server.js` sobe **dois** servidores: o painel local (só `127.0.0.1`, exige Host local) e a
  porta pública, que o túnel publica: `/callback`, `/webhook`, `/saude` e, com `PAINEL_ONLINE`
  (padrão), o painel online (`tratarPainel(req, res, true)`). Online: a senha nunca é criada
  (só no computador), login com limite de tentativas, POST só com Origin do endereço público,
  cookie Secure. Rota nova de API herda essas regras; não crie atalho que as contorne.
- Senha do painel, App ID e chave secreta ficam no SQLite (tabela `estado`), não no `.env`.
  O `.env` é criado sozinho e guarda só a `ML_DB_KEY` e portas.
- A URL do túnel muda a cada reinício; `app-ml.js#situacao` compara com o cadastro real do
  app no ML (lido via `client_credentials`). É isso que dispara o aviso "a URL mudou".
- Túnel: `tunel.js` (cloudflared; localtunnel via npx só como reserva). A primeira consulta
  DNS do endereço novo vai aos servidores autoritativos — não troque por `fetch` direto
  (NXDOMAIN com TTL negativo de 30 min; ver comentário no arquivo).
- Promoções (`promocoes.js`) e devoluções (`devolucoes.js`) exportam `criar(deps)` com rotas
  que o `server.js` registra no mesmo `routes`/`rotasParam`. A venda é ligada à promoção por
  `/orders/{id}/discounts` → oferta → promoção, com cache no SQLite (`promo_*`, `devolucoes`).
  Custo de devolução = frete de ida + `return-cost` (o `receiver.cost` é o valor cheio, fora da soma).
  Promoções por anúncio: `desconto_max` / `lucro_min` (%) deixam só as promoções DISPONÍVEIS
  (candidate) dentro do limite (`promoNoFiltro`); o lucro de cada uma é calculado na hora
  (`lucroDe`, preço = do ML › sugerido › maior aceito) e fica no cache de 10 min.
- Custos (`custos.js`): SKU do anúncio `KIT-407.408` = produtos 407 + 408 da tabela
  `produtos_custo` (importada colando a planilha na tela Empresa). `custos.origem` 'sku' é
  recalculado; 'manual' nunca é sobrescrito. Imposto da empresa = soma dos impostos cadastrados.
- Acompanhamento (`painel.js`): Performance, ABC, Full, qualidade dos anúncios e avisos.
  Venda do Full = `vendas.origem` (node_id do estoque) diferente de `BRP…`; estoque no Full =
  `/user-products/{id}/stock` (meli_facility). Menu lateral único em `public/menu.js`; sino de
  avisos em `public/sino.js` (os dois carregados em todas as telas).
  Tipo de envio (Performance): Full pela origem do estoque; Flex = `logistic_type`
  `self_service` de `/shipments/{id}`, uma consulta por envio guardada em `envio_logistica`.
- Cliente da venda (busca em Pedidos e Devoluções): `vendas.comprador` (apelido, vem na lista
  de pedidos) e `comprador_nome` (só em `/orders/{id}`: 200 por abertura em segundo plano,
  `custos.js#nomesDosClientes`; Devoluções lê o pedido direto quando falta). Dado pessoal: o
  `mcp.js#semCliente` tira esses campos de toda resposta ao Claude. Amazon não tem cliente.
- Financeiro (`financeiro.js`, tela `public/financeiro.html`): o dinheiro das vendas do ML pelo
  Mercado Pago, com o MESMO token da conta (`/v1/payments/search`; saldo direto dá 403). Cópia em
  `mp_pagamentos` (1ª leitura 120 dias; depois por `date_last_updated`, a cada 10 min no máximo).
  Líquido = `net_received_amount`; cobranças por `charges_details` (só as pagas pelo vendedor;
  `financing_transfer` payer→collector abate a taxa de parcelamento — com isso bruto − cobranças
  bate com o líquido em 100% das vendas, medido nas duas contas). A receber = aprovado e
  `money_release_status` pending; liberação vencida e ainda pendente = retido.
  Extrato (aba "Extrato e saldo", `GET /api/financeiro/extrato`): relatório de liberações
  (`/v1/account/release_report`: pede, espera ~2-5 min, baixa o CSV) em `mp_extrato` +
  `mp_extrato_saldos`; 1ª vez 90 dias, depois do dia anterior ao último, no máximo a cada 6 h.
  Saldo inicial + créditos − débitos = saldo final (conferido a cada relatório). Conta sem a
  configuração do relatório (404): só cria quando o vendedor clica "Ativar" na tela.
  Conferência (aba "Conferência", `GET /api/financeiro/conferencia`, `PUT …/conferencia/{pag|venda}:{id}`):
  liga cada pagamento à venda — pedido; frete pago à parte (`marketplace_shipment`) pelo ENVIO
  do `external_reference`; crédito de reclamação pela regra das Devoluções ou pelo crédito
  digitado lá. Bônus do Flex (incentivo do ML, um por venda Flex) e parte dos créditos de
  reclamação trazem `point_of_interaction.transaction_data.reference_type/reference_id`:
  "shipment" = envio da venda (`envio_id`), "payment" = pagamento da venda (`ref_pagamento`);
  "coverage" não abre em nenhuma rota (404). O external_reference "cashback_…" não serve. O que
  sobra fica "a conferir" com o motivo; o vendedor liga à mão, anota e marca (`mp_conferencia`).
- Reputação (`reputacao.js`, tela `public/reputacao.html`, MCP `ml_reputacao`): termômetro e métricas
  de 60 dias de `/users/{id}.seller_reputation`; cada reclamação (mediations + returns, 90 dias) é
  perguntada em `/post-purchase/v1/claims/{id}/affects-reputation` (cache `rep_reclamacoes` pelo
  last_updated; medido: as "affected" batem com metrics.claims.value). Afetaram + abertas (em risco)
  ganham detalhe do ML, ações do vendedor (`available_actions`), produto e `sugestaoDe` (por
  categoria do `reason.name`: broken_item, different_than_published…) com mensagem pronta.
  Cancelamentos: só `cancel_detail.requested_by/group = seller`. Atrasos: a API só dá o número.
- Central de mensagens (`mensagens.js`, tela `public/mensagens.html`, item "Mensagens" do menu): o que
  espera resposta em TODAS as contas — ML: perguntas (UNANSWERED), pós-venda (`/messages/unread` +
  packs vistos guardados em `msg_packs` por 15 dias, lidos com mark_as_read=false) e reclamações em que
  a conta é a vendedora, pode mandar mensagem (`send_message_to_complainant|mediator`) e o último a
  falar não foi ela (ou o detail diz que a vez é dela); Shopee: sellerchat em que o comprador falou
  por último. Amazon: só o link do Seller Central (a SP-API não lê mensagens de comprador).
  Responder = escrita só pela tela, com confirmação (limites: pergunta 2.000, pós-venda 350, chat
  1.000). Mensagens padrão em `mensagens_modelos`, com {comprador} {produto} {pedido}; a tela coloca
  o texto no campo e o vendedor edita antes de enviar. Mensagem de comprador é dado pessoal: nada no MCP.
- Calculadora reversa (`calculadora.js`, tela `public/calculadora.html`, `GET /api/calculadora?preco=&margem=&sku=`):
  preço de venda + margem -> quanto se pode pagar no produto em cada marketplace (custo máximo =
  preço − tarifa − frete − imposto − embalagem − outros − margem). ML: tarifa de listing_prices na
  categoria do anúncio da conta com os MESMOS produtos do SKU (senão um que os contenha, a prevista
  pelo nome ou a categoria que mais vende); frete médio Mercado Envios (sem Flex) do anúncio ou da
  conta na faixa abaixo/acima de R$ 79 — medido: o vendedor paga frete também abaixo de R$ 79. Tarifa do
  ML editável no cartão: `t_{conta}=` (só aquele cálculo) › padrão da conta (`calc_tarifa_ml:{id}` em
  `estado`, `POST /api/calculadora/tarifa`, null volta à da categoria) › listing_prices. Frete editável
  em todos os cartões (`comFrete`): `f_{canal}=` › padrão `calc_frete:{ml:id:me|flex | shopee:loja |
  amazon:FBA|proprio}` (`POST /api/calculadora/frete`) › o calculado. Embalagem igual (`comEmbalagem`,
  `e_{canal}=`, `calc_embalagem:{ml:id | shopee:loja | amazon:FBA|proprio}`, `POST /api/calculadora/embalagem`). Amazon: a calculadora lê o
  financeiro antes (até 8 s) e o frete do FBA = tarifa de envio por unidade + armazenagem; Flex =
  entrega_flex − bônus médio. Shopee: tabela medida (`tarifaShopee`). Amazon: média real do
  financeiro (`taxasDosLancamentos`). Sem ferramenta MCP (tem dado da Amazon).
- Devolução de kit: o vendedor marca QUAIS produtos do SKU vendido estão com defeito
  (`devolucao_defeito.produtos` = posições nos componentes); só eles somam, vezes a quantidade.
- Flex do ML (`custos.js#freteFlex`): o Mercado Pago NÃO cobra o frete do `/costs` em venda Flex;
  o ML paga um bônus por envio (`bonificaciones_flex`, ligado pelo envio) = tarifa Flex − custo do
  vendedor no /costs. Com `empresa.entrega_flex` (o que o vendedor paga à empresa de entrega)
  informado: frete = entrega − bônus (sem bônus ainda: média da conta para o caso, estimado).
  Sem ele, vale o /costs (comportamento antigo).
- Custo por anúncio: `custos.outros` = embalagem (NULL = padrão da empresa) e `custos.extra` =
  outro custo; `custosDe().outros_total` é a soma para as contas que usam `A.economia`.
- Mudanças nas campanhas do Ads: o ML não tem histórico; `server.js#registrarCampanhas` compara
  com a última configuração vista (`ads_campanhas`) e grava em `ads_mudancas`. Acompanha
  `budget` (orçamento do vendedor), não `daily_budget` (oscila sozinho). Confere a cada 30 min
  junto com `/api/avisos`.
- Publicar na Shopee e na Amazon (`publicar-canais.js`, tela `publicar-canais.html`; o menu
  Publicar abre ela com a conta Shopee/Amazon): COPIA um anúncio do ML. Shopee: categoria por
  `category_recommend`, atributos por `get_attribute_tree`, marca da loja, fotos do ML (só
  *.mlstatic.com) por `shopee.js#subirImagem`, `add_item`. Amazon: oferta (LISTING_OFFER_ONLY) num
  ASIN achado pelo EAN; prévia com `mode=VALIDATION_PREVIEW`; SKU que já existe é RECUSADO (o PUT
  sobrescreveria o anúncio). Escrita só no clique da tela.
- Troca de SKU (Produtos): a tela também busca os anúncios do produto NOVO e marca em amarelo (e
  deixa desmarcado) o anúncio que ficaria com SKU igual ao de outro — o vendedor decide.
- Atacado em massa (`precos.js`, bloco na tela Produtos): `GET /api/atacado` lista os anúncios
  ativos com o atacado de cada um (uma chamada por anúncio, guardada em `anuncio_atacado`);
  `POST /api/atacado/aplicar` e `/remover` usam o mesmo `gravarAtacado` do anúncio individual.
- Em massa: `POST /api/items/status-em-massa` (pausar/reativar, até 300) e
  `POST /api/produtos/:n/trocar-sku` (troca um produto dentro do SKU, `custos.js#trocarComponente`).
- Identidade: o código não tem marca de empresa. Nome e logo são digitados na tela Empresa
  (`PUT /api/marca`, tabela `estado`), o logo sai em `GET /api/marca/logo` e `public/menu.js`
  pinta os dois em todas as telas. Logo só PNG/JPG/WebP conferido pelos bytes — SVG não.
  Cada conta tem a sua (`marca_nome:{id}`, `marca_logo:{id}`); sem ela vale a geral e o apelido.
- Várias contas: a tela "Todas as contas" (`public/geral.html`) usa `GET /api/contas/resumo?dias=`
  (`custos.js#resumoDasContas`): roda as vendas de cada conta conectada (hoje e o período), soma
  e junta os produtos por SKU. O Dashboard (`/`) continua sendo só da conta selecionada.
  A tabela de produtos (`produtos_custo`) é uma só para todas as contas.
- Shopee (`shopee.js`, tela `public/shopee.html`): por enquanto só a conexão da loja. Partner ID
  e Partner Key digitados na tela (chave cifrada em `estado`), autorização com retorno em
  `/shopee/callback/{state}` pela porta pública, tokens em `shopee_lojas` (refresh de uso
  único: `shopeeTokensGravar` na hora) e `GET /api/shopee/diagnostico`, que mostra o que a
  Shopee devolve de verdade. Vendas e lucro da Shopee ainda NÃO existem: construir a partir
  do que o diagnóstico mostrar com a loja real, não da documentação.
  Vendas e lucro da Shopee (`shopee-vendas.js`, por loja `?loja=`): pedidos copiados em
  `shopee_pedidos`/`shopee_itens` (lista em janelas de 15 dias; 1ª leitura 152 dias; detalhe
  50 por chamada; repasse `get_escrow_detail` 200 por leitura). Lucro EXATO: o repasse
  (`escrow_amount`) já vem sem comissão, taxas, frete e cupons; tarifa+frete = faturamento −
  recebido, rateado entre os itens. Sem repasse ainda = proporção média da loja (`estimado`).
  Frete da Shopee: o repasse INCLUI o frete que a Shopee paga ao vendedor (`final_shipping_fee` +
  `buyer_paid_shipping_fee` = `frete_shopee`). "Entrega Direta" (`shipping_carrier`, guardado em
  `transportadora`) = o vendedor entrega e paga a empresa de entrega: custo por pedido em
  `empresa.entrega_propria` (tela Empresa da conta Shopee; sem ele o lucro fica pendente).
  Tarifa = faturamento − recebido + frete_shopee; frete = entrega própria − frete_shopee.
  Taxa fixa por unidade da Shopee (mostrada separada; já está DENTRO da tarifa): `taxaFixaDe` =
  `service_fee` − transação × preço (2%; 1,4% desde 01/10/2026, data da compra em Brasília). Medido
  em 562 pedidos: R$ 4 (R$ 4,50 desde 01/10) até R$ 79,99, R$ 16 de 80 a 99,99, R$ 20 de 100 a
  199,99, R$ 26 de 200 em diante; comissão 18% abaixo de R$ 80 e 12% acima (+0,6 p.p. desde 01/10).
  NÃO use a `net_service_fee_info_list`: em metade dos pedidos ela mistura a taxa fixa na regra de %.
  Embalagem na Shopee = uma por PEDIDO (`embalagem_padrao` da empresa da loja), rateada pelo valor.
  Campanhas e devoluções da Shopee (`shopee-campanhas.js`, telas `shopee-campanhas.html` e
  `shopee-devolucoes.html`; o menu troca Campanhas/Devoluções por elas): descontos, ofertas
  relâmpago e cupons da loja (com as vendas dos itens no período); devoluções em janelas de 15 dias
  (`returns/get_return_list`), sem o campo `user`. Campanhas da própria Shopee não têm API.
  Itens (e vendas) só dos descontos ativos, agendados ou encerrados há até 60 dias, 4 por vez.
  Criar (escrita só pela tela, com confirmação; nada no MCP): `POST /api/shopee/campanhas/desconto`
  (add_discount + add_discount_item; sem nenhum item aceito apaga a campanha vazia), `/relampago`
  (horários de `GET …/horarios` = get_time_slot_id, 1 por dia 00h–24h; até 50 itens com estoque da
  oferta) e `/cupom` (add_voucher; código 1–5 letras/números, loja toda ou produtos). Resultado:
  `GET /api/shopee/campanhas/metricas?tipo=desconto|relampago|cupom&id=` = vendas e lucro dos itens
  da campanha no período (cupom: pedidos com `cupom_vendedor`) contra os mesmos dias antes, e os
  anúncios que mais venderam (`metricasDe`, sobre `shopee-vendas.js#linhasDe`).
  Cada loja é uma conta externa `shopee-{loja}` (como `amazon`): na lista do topo
  (`menu.js#TELAS`), identidade `marca_*:shopee-{loja}`, empresa `empresa:shopee-{loja}`
  (sem salvar = a da 1ª conta do ML) e em "Todas as contas". As respostas das telas são
  montadas em `canais.js` (o mesmo formato das rotas do ML) — use-o para a Magalu (a Leroy já usa).
  Anúncios da Shopee (`shopee-anuncios.js`, tela `public/shopee-anuncios.html`; o menu troca
  `/anuncios.html` por ela): cópia em `shopee_anuncios` (relida a cada 6 h em segundo plano),
  preço muda em `update_price` (original_price). `has_promotion` também vale para ATACADO
  ("Whole Sale"): "em promoção" na tela = preço atual < original. Taxa estimada por SKU =
  (tarifa+frete)/faturamento dos repasses de 90 dias. Concorrentes na Shopee: não há API e o
  scraper só lê o ML. Ads da Shopee (`shopee-ads.js`, `public/shopee-ads.html`): saldo e
  desempenho diário da loja; detalhe por campanha só quando houver campanha real para medir.
- Amazon (`amazon.js`, tela `public/amazon.html`): por enquanto só a conexão. Aplicativo
  privado (Rascunho) autorizado no próprio Seller Central: Client ID, Client Secret e Refresh
  Token digitados na tela (segredo e token cifrados em `estado`), testados com a Amazon antes
  de gravar. SP-API região NA, marketplace Brasil `A2Q3Y263D00KWC`, sem assinatura AWS.
  Compromissos declarados à Amazon no cadastro (não afrouxe): nenhum dado pessoal de
  comprador (sem RDT; `semPessoais` em toda resposta), dados da Amazon NUNCA no MCP
  (`test-amazon.js` reprova) e o diagnóstico mostra só a forma das respostas, sem valores.
  Plano de incidentes: `PLANO-DE-RESPOSTA-A-INCIDENTES.md` (revisão a cada 6 meses).
  Vendas e lucro (`GET /api/amazon/vendas`): pelos lançamentos financeiros
  (`finances/v0/financialEvents`, data = PostedDate), copiados em `amazon_lancamentos` (no
  máximo a cada 10 min; 1ª leitura = 92 dias). Custo pelo SKU (`produtos_custo`; hífen também
  separa os produtos: `KIT-795-615-746-698`). Pedido FBA de 2+ unidades vem em uma linha por
  unidade com o MESMO OrderItemId e data: a 2ª em diante ganha `|2`, `|3` na chave (`lancamentosDe`).
  Cobranças avulsas vêm da API de transações (`/finances/2024-06-19/transactions`, ServiceFee, com
  data e id; a v0 as manda sem data), leitura própria (`amazon_serv_lido_em`): `servicosDe` grava
  a etiqueta do envio próprio (MfnPostageFee, com ORDER_ID) como tipo `etiqueta` e armazenagem,
  envio ao armazém, remoção do FBA e mensalidade como `servico` (custo da conta). `comEtiquetas`
  põe a etiqueta no frete das vendas do mesmo pedido; `taxasDosLancamentos` dá `armazem_un` (FBA)
  e soma ela ao frete dos pedidos FBA, aos anúncios e à calculadora. A Amazon é uma "conta" própria na lista do topo
  (`menu.js` acrescenta a opção): identidade `marca_*:amazon` e empresa `empresa:amazon`
  (`/api/marca?conta=amazon`, `/api/empresa?conta=amazon`, tela `empresa.html?conta=amazon`);
  sem empresa salva, vale a da conta do ML em `amazon_empresa_conta`.
  Telas do ML com a Amazon (`?conta=amazon`; `menu.js#COM_AMAZON` leva o parâmetro nos links):
  Pedidos/Vendas Hoje, Performance e ABC chamam `/api/amazon/pedidos|performance|abc` (mesmo
  formato das rotas do ML). Base: pedidos copiados em `amazon_pedidos`/`amazon_itens` (data da
  COMPRA, como no ML; 1ª leitura 152 dias; itens 1 por pedido, 0,5/s, em segundo plano) + taxas
  reais do financeiro por pedido+SKU; sem lançamento ainda = média do SKU/canal (`estimado`).
  Full com a Amazon = FBA (`/api/amazon/full`, estoque de `/fba/inventory/v1/summaries`).
  Anúncios da Amazon: tela própria `public/amazon-anuncios.html` (o menu troca `/anuncios.html`
  por ela). Lista pela Listings API (`searchListingsItems`, ID do vendedor tirado de uma
  transação financeira e guardado em `amazon_seller_id`); preço muda em
  `POST /api/amazon/anuncios/preco` = PATCH do `purchasable_offer` lido na hora, trocando só o
  `our_price` da oferta ao consumidor (mínimo/máximo e B2B ficam). Escrita: só pela tela.
  Concorrentes: `getItemOffers` (um ASIN) e `getItemOffersBatch` (todos, em segundo plano,
  `amazon_concorrencia`). A API só dá o código do vendedor: o nome NÃO é raspado do site
  (declaramos à Amazon que os dados vêm só da SP-API) — a tela tem o link da loja pública e o
  vendedor digita o nome (`amazon_vendedores`). Venda de concorrente não existe; só o BSR.
- Leroy Merlin (`leroy.js`, tela `public/leroy.html`): conexão, vendas, lucro e repasses. Plataforma Mirakl:
  endereço do portal (*.mirakl.net, a API mora no mesmo host) + chave de API de um USUÁRIO da loja
  (header Authorization, sem Bearer; cifrada em `estado`) + ID da loja opcional. Gerar chave nova
  invalida a anterior daquele usuário: usar um usuário só do painel (o Bling usa outro). Diagnóstico
  (A01 conta, OR11 pedidos, IV01 documentos, TL02 transações) mostra a forma, sem dado de comprador
  (`semPessoais`, que também tira os `order_additional_fields` customer-*/shipping-address-*). Nada
  da Leroy no MCP (`test-leroy.js` reprova).
  Vendas e lucro: conta externa `leroy` (lista do topo, `empresa:leroy`, `marca_*:leroy`, "Todas as
  contas"); `/api/leroy/pedidos|performance|abc|vendas` montadas em `canais.js`. Cópia em
  `leroy_pedidos` (só o que o lucro usa, `pedidoDe`: do comprador SÓ nome e sobrenome em `cliente`, como o
  comprador_nome do ML — a leitura dos pedidos é a única com `mk(…, { pessoais: true })`; foto = caminho
  /media/product/image/{uuid}, pública em {host}/mmp{caminho}; 1ª leitura 152 dias, depois `start_update_date`),
  `leroy_transacoes` (TL02) e `leroy_ciclos` (IV01 AUTO_INVOICE), no máximo a cada 10 min. Por linha:
  recebido = price + shipping_price − (total_commission + commission_vat) − reembolsos (amount +
  shipping_amount) + commission_total_amount devolvida — medido: bate com as transações em 90 de 90
  linhas. Tarifa = comissão líquida + reembolsos; frete = o que o vendedor pagou pela entrega do pedido
  (contratada no Melhor Envio, digitada na coluna Frete da tela Pedidos: `POST /api/leroy/frete`, tabela
  `leroy_fretes`; sem ela vale `empresa.entrega_propria`, marcado ≈) rateado − frete pago pelo cliente
  (a Leroy o repassa); sem nenhum dos dois o lucro fica pendente.
  Repasses (`GET /api/leroy/repasses`, tela leroy.html): ciclo fecha dia 10 e 25 (00h Brasília),
  vencimento = fechamento + 25 dias; PAYABLE = próximo ciclo, PENDING = cliente ainda não recebeu.
- Magalu (`magalu.js`, tela `public/magalu.html`): conexão, vendas e lucro. Aplicativo criado pelo vendedor no
  IDM (`idm client create`, ID Magalu CLI): Client ID/Secret na tela (segredo e refresh cifrados). Retorno FIXO em
  localhost (`http://localhost:{porta}/magalu/callback`, atendido em `tratarPainel` só local, com a sessão; a Magalu
  aceita localhost) — a troca do túnel não quebra. Login em id.magalu.com/login com choose_tenants=true (a LOJA),
  token em id.magalu.com/oauth/token (JSON na troca, formulário na renovação; grava o refresh novo). API em
  api.magalu.com/seller/v1 (orders, financial-analysis/orders em janelas de 15 dias, promotions). Diagnóstico mostra
  a forma, sem dado de comprador (`semPessoais`). Nada no MCP (`test-magalu.js`).
  Vendas e lucro: conta externa `magalu` (como a Leroy: lista do topo, `empresa:magalu`, "Todas as contas",
  Campanhas só leitura). Cópia em `magalu_pedidos` (`pedidoDe`) e `magalu_financeiro` (`transacoesDe`), janelas de 15 dias
  (1ª leitura 152 dias por purchased_at, depois updated_at). Recebido = créditos − débitos da análise financeira, SEM
  os débitos ABSOLUTE_DISCOUNT (preço promocional, regra da doc) e as linhas not_applicable (`financeiroDo`); tarifa =
  faturamento − frete debitado − recebido; frete = SHIPPING_COST + SHIPPING_SHARE (o frete pago pelo cliente fica com
  a Magalu: a SALE não o inclui). Sem financeiro: amounts.commission do pedido (= comissão + tarifa fixa + MDR,
  medido) como estimado. O financeiro NÃO diz em qual depósito (semanal, às segundas) o pedido foi pago.
  Anúncios da Magalu (tela `magalu-anuncios.html`; o menu troca `/anuncios.html` por ela): `/portfolios/skus` (100 por
  página; 1.692 SKUs medidos) + preço e estoque UM SKU por chamada (`/portfolios/prices|stocks/{sku}`; a lista sem SKU dá
  404), em segundo plano, 3 por vez, relidos a cada 6 h (`magalu_anuncios`). Vários anúncios usam um código numérico da
  Magalu no lugar do SKU: o vendedor digita o "SKU do painel" (`sku_vinculos`, canal `magalu`, `PUT /api/magalu/sku-vinculo`)
  e ele dá o custo nos Anúncios e nos Pedidos (`linhasDe` ctx.vinculos; `sku_magalu` guarda o código original).
- Comandas de separação (`comandas.js`, tela `public/comandas.html`, item do menu entre Todas as contas e Dashboard):
  envios que ainda vão sair, de TODAS as contas, por categoria — Flex (ML self_service + Shopee "Entrega Direta" + Magalu
  VAPT), Mercado Envios (ML coleta/ponto; Full fora), Magalu, Melhor Envios (Leroy), Shopee (sem Entrega Direta) —
  numeradas por categoria e DIA na 1ª vez que aparecem (`numerar`, tabela `comandas`; o número não muda). ML:
  /orders/search?shipping.status=ready_to_ship agrupado pelo envio (pack) + /shipments/{id} (tipo, receiver_name) +
  /shipments/{id}/sla (prazo de despacho); Shopee READY_TO_SHIP/PROCESSED (ship_by_date, recipient_address.name);
  Magalu entregas não despachadas (`mg(…, { pessoais: true })` só aqui); Leroy OR11 SHIPPING. Do cliente só o NOME
  (vai impresso, em letra grande, para as câmeras). Impressão: @page 80 mm pelo diálogo do navegador; depois o vendedor
  confirma e a comanda vira "impressa" (`POST /api/comandas/impressas`). Código de barras Code 128 em
  `public/codigo128.js` (testado). Nada no MCP (`test-comandas.js`).
- Campanhas da Amazon e da Leroy (`campanhas-canais.js`, tela `public/campanhas-canais.html?conta=amazon|leroy`; o menu
  troca Campanhas por ela): (1) preço promocional com início e fim em cada anúncio, agrupado pelo período,
  com o resultado (vendas e lucro no período contra os mesmos dias antes); criar/encerrar só pelo clique, com
  confirmação. Amazon: `purchasable_offer.discounted_price` (`amazon.js#mudarOferta`, um PATCH por SKU).
  Leroy: PRI01 (`/api/offers/pricing/imports`, CSV `csvPrecosMirakl`, 1 por minuto, conferido no PRI02/PRI03)
  — NUNCA OF24: ele zera os campos não enviados (estoque do Bling). PRI01 apaga os PREÇOS não enviados: oferta
  com preço por canal/quantidade (`ofertaDe`.complexo) é recusada. (2) Promoções nas vendas, com resultado:
  Amazon pela PromotionList do financeiro (`amazon_lancamentos.promocoes`, PromotionId = nome da promoção do
  Seller Central; parte vem sem id); Leroy pelas promotions da linha do pedido e PR01 (/api/promotions).
  Convites de cupom/oferta relâmpago/Prime da Amazon não têm API (a tela leva ao Seller Central). Nada no MCP.
- Amazon Ads (`amazon-ads.js`, tela `public/amazon-ads.html`; no modo Amazon o menu troca
  `/ads.html` por ela): por enquanto só a conexão. Perfil de segurança do Login with Amazon
  (Client ID/Secret na tela, segredo e refresh cifrados), autorização em amazon.com/ap/oa com
  retorno FIXO em `/amazon-ads/callback` na porta pública (cadastrar em "Allowed Return URLs";
  state de uso único), perfil do Brasil em `amzads_perfil`. Aviso de privacidade público em
  `/privacidade` (exigido no perfil de segurança). Campanhas/histórico: construir a partir do
  diagnóstico com a conta real. Nada do Ads no MCP. Em "Todas as contas" a Amazon é
  somada NO NAVEGADOR (`geral.html#comAmazon`): `/api/contas/resumo` é usada pelo MCP.
- Concorrentes no ML (`concorrentes.js`, bloco em Anúncios → Detalhes): a API do ML dá 403
  para busca e anúncio de terceiros, então vêm do scraper (`/posicao`, a mesma busca da
  Posição). Vendidos = total da vida, EM FAIXAS (+100, +500…); venda de 30 dias de concorrente
  não existe. Cada busca grava a faixa (`ml_conc_medidas`) para mostrar "subiu de faixa"; os
  marcados "igual ao meu" ficam em `ml_concorrentes` e o filtro `/api/items?concorrentes=1`
  usa a mesma lista de ids do filtro por produto. Anúncios das contas conectadas saem da lista
  (`classificarBusca` + nome do vendedor). Lucro em cada preço: `/api/items/:id/lucro-nos-precos`.
- Scraper: `scraper-processo.js` sobe e reinicia o Python; ele escuta só em `127.0.0.1`.
- `mcp.js` expõe as MESMAS rotas do painel como ferramentas MCP (stdio, sem porta, sem OAuth:
  usa a conta já conectada). Ferramenta nova = uma linha na tabela `FERRAMENTAS` apontando
  para a rota; `server.js#despachar` é o único caminho, e `test-mcp.js` reprova ferramenta
  que aponte para rota inexistente. O repasse livre à API do ML (`ml_api`) mora só no MCP e
  usa `server.js#ml` — não crie rota HTTP equivalente (ver "Nunca").

- Acesso ao painel (`seguranca.js`): senha de 12+ caracteres com letra, número e especial,
  validade de 365 dias, e verificação em duas etapas (TOTP) OBRIGATÓRIA. Sem 2FA ativo ou com
  senha fraca/vencida, `tratarPainel` só abre `/ativar-2fa` e `/trocar-senha` (API dá 403 com
  `pendencia`). Exigência da Amazon para a SP-API; não afrouxe. Perdeu o celular:
  `npm run desativar-2fa` no próprio computador.

## Nunca

- Commitar `.env`, `dados.sqlite*`, `logs/`, `scraper/.sessao_ml/` (cookies da conta logada).
- Pedir App ID, chave secreta ou senha no chat: eles são digitados no painel.
- Usar `Referrer-Policy: no-referrer` no painel: o navegador passa a mandar `Origin: null`
  no POST do login e a checagem de origem recusa o próprio usuário.
- Expor a porta do scraper pelo túnel, ou deixar o primeiro acesso (criar senha) alcançável online.
- Criar rota HTTP de repasse para a API do Mercado Livre: pela porta pública ela vira "faça
  qualquer coisa na conta do vendedor" para quem achar a URL do túnel. Repasse é só no MCP.
