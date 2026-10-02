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
  digitado lá. Bônus do Flex não tem venda (o código dele não é pedido nem envio: 404). O que
  sobra fica "a conferir" com o motivo; o vendedor liga à mão, anota e marca (`mp_conferencia`).
- Devolução de kit: o vendedor marca QUAIS produtos do SKU vendido estão com defeito
  (`devolucao_defeito.produtos` = posições nos componentes); só eles somam, vezes a quantidade.
- Custo por anúncio: `custos.outros` = embalagem (NULL = padrão da empresa) e `custos.extra` =
  outro custo; `custosDe().outros_total` é a soma para as contas que usam `A.economia`.
- Mudanças nas campanhas do Ads: o ML não tem histórico; `server.js#registrarCampanhas` compara
  com a última configuração vista (`ads_campanhas`) e grava em `ads_mudancas`. Acompanha
  `budget` (orçamento do vendedor), não `daily_budget` (oscila sozinho). Confere a cada 30 min
  junto com `/api/avisos`.
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
  Cada loja é uma conta externa `shopee-{loja}` (como `amazon`): na lista do topo
  (`menu.js#TELAS`), identidade `marca_*:shopee-{loja}`, empresa `empresa:shopee-{loja}`
  (sem salvar = a da 1ª conta do ML) e em "Todas as contas". As respostas das telas são
  montadas em `canais.js` (o mesmo formato das rotas do ML) — use-o para Magalu e Leroy.
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
  separa os produtos: `KIT-795-615-746-698`). A Amazon é uma "conta" própria na lista do topo
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
