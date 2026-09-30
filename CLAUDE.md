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
- Devolução de kit: o vendedor marca QUAIS produtos do SKU vendido estão com defeito
  (`devolucao_defeito.produtos` = posições nos componentes); só eles somam, vezes a quantidade.
- Custo por anúncio: `custos.outros` = embalagem (NULL = padrão da empresa) e `custos.extra` =
  outro custo; `custosDe().outros_total` é a soma para as contas que usam `A.economia`.
- Mudanças nas campanhas do Ads: o ML não tem histórico; `server.js#registrarCampanhas` compara
  com a última configuração vista (`ads_campanhas`) e grava em `ads_mudancas`. Acompanha
  `budget` (orçamento do vendedor), não `daily_budget` (oscila sozinho). Confere a cada 30 min
  junto com `/api/avisos`.
- Em massa: `POST /api/items/status-em-massa` (pausar/reativar, até 300) e
  `POST /api/produtos/:n/trocar-sku` (troca um produto dentro do SKU, `custos.js#trocarComponente`).
- Identidade: o código não tem marca de empresa. Nome e logo são digitados na tela Empresa
  (`PUT /api/marca`, tabela `estado`), o logo sai em `GET /api/marca/logo` e `public/menu.js`
  pinta os dois em todas as telas. Logo só PNG/JPG/WebP conferido pelos bytes — SVG não.
- Scraper: `scraper-processo.js` sobe e reinicia o Python; ele escuta só em `127.0.0.1`.
- `mcp.js` expõe as MESMAS rotas do painel como ferramentas MCP (stdio, sem porta, sem OAuth:
  usa a conta já conectada). Ferramenta nova = uma linha na tabela `FERRAMENTAS` apontando
  para a rota; `server.js#despachar` é o único caminho, e `test-mcp.js` reprova ferramenta
  que aponte para rota inexistente. O repasse livre à API do ML (`ml_api`) mora só no MCP e
  usa `server.js#ml` — não crie rota HTTP equivalente (ver "Nunca").

## Nunca

- Commitar `.env`, `dados.sqlite*`, `logs/`, `scraper/.sessao_ml/` (cookies da conta logada).
- Pedir App ID, chave secreta ou senha no chat: eles são digitados no painel.
- Usar `Referrer-Policy: no-referrer` no painel: o navegador passa a mandar `Origin: null`
  no POST do login e a checagem de origem recusa o próprio usuário.
- Expor a porta do scraper pelo túnel, ou deixar o primeiro acesso (criar senha) alcançável online.
- Criar rota HTTP de repasse para a API do Mercado Livre: pela porta pública ela vira "faça
  qualquer coisa na conta do vendedor" para quem achar a URL do túnel. Repasse é só no MCP.
