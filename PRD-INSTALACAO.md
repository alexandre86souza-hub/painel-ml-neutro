# PRD — Instalar e rodar o projeto "Aula Mercado Livre - Henrique Niada"

> **Aluno:** copie este arquivo inteiro e cole no Claude Code, numa pasta vazia.
> Antes, troque `SEU_USUARIO` pelo seu usuário do GitHub (se você já fez o fork).
>
> **Claude Code:** este documento é a sua tarefa. Execute do início ao fim, sem pedir
> confirmação a cada passo. Converse com o aluno em **português do Brasil**, em linguagem
> simples: ele pode nunca ter usado terminal.

---

## Objetivo

Deixar o projeto rodando no computador do aluno, com o painel aberto no navegador, e
acompanhar o aluno até a conta do Mercado Livre estar conectada.

Repositório original: `https://github.com/ElioBonfim/Aula-Mercado-Livre-Henrique-Niada`

## Regras (valem para a sessão inteira)

1. **Nunca peça ao aluno para colar App ID, chave secreta ou senha aqui no chat.** Eles são
   digitados **no painel** (`http://localhost:3100`). Se o aluno colar mesmo assim, avise
   que a chave deve ser trocada no DevCenter e não repita o valor em nenhuma resposta.
2. **Não use Docker**, nem proponha usar.
3. **Não edite `.env`, `dados.sqlite` ou arquivos do projeto** para "resolver" instalação.
   O `npm run setup` e o `npm start` cuidam de tudo; se algo falhar, leia a mensagem deles.
4. **Nunca faça commit** de `.env`, `dados.sqlite*`, `logs/` ou `scraper/.sessao_ml/`.
5. O `npm start` é um processo que **fica rodando**: rode em segundo plano e não o encerre
   ao terminar a tarefa.

## Passo 1 — Descobrir o sistema

Identifique se é macOS, Windows ou Linux. Os comandos abaixo mudam conforme o sistema.

## Passo 2 — Pré-requisitos

| Ferramenta | Conferir | Instalar se faltar |
|---|---|---|
| Git | `git --version` | macOS: `xcode-select --install` · Windows: `winget install --id Git.Git -e` · Linux: `sudo apt install git` |
| Node.js **22.13 ou maior** | `node -v` | macOS: `brew install node` (sem Homebrew: instalador LTS de https://nodejs.org) · Windows: `winget install OpenJS.NodeJS.LTS` · Linux: https://nodejs.org |

- No Windows, depois de instalar pelo `winget`, o terminal atual não enxerga o programa
  novo: abra um terminal novo (ou atualize o `PATH` da sessão) antes de seguir.
- **Não instale Python, uv nem Chromium à mão**: o `npm run setup` faz isso.

**Pronto quando:** `node -v` mostra `v22.13` ou maior e `git --version` responde.

## Passo 3 — Baixar o projeto

Prefira o fork do aluno (é o que a aula ensina):

- Se o `gh` estiver instalado e logado (`gh auth status`):
  `gh repo fork ElioBonfim/Aula-Mercado-Livre-Henrique-Niada --clone`
- Senão, se o aluno já fez o fork pelo site:
  `git clone https://github.com/SEU_USUARIO/Aula-Mercado-Livre-Henrique-Niada.git`
- Se o aluno não tiver conta no GitHub, clone o original e explique que o fork pode ser
  feito depois: `git clone https://github.com/ElioBonfim/Aula-Mercado-Livre-Henrique-Niada.git`

Entre na pasta: `cd Aula-Mercado-Livre-Henrique-Niada`

## Passo 4 — Instalar

```bash
npm run atualizar
npm install
npm run setup
```

O `atualizar` traz as correções mais novas do repositório da aula: um fork feito antes de
uma correção **não** a recebe sozinho. Se ele disser que há alterações não salvas, pare e
mostre ao aluno.

O `setup` instala o `uv`, o Python 3.12, as dependências do scraper e o Chromium, cria o
`.env` com uma chave de cifra e roda os testes. No fim ele imprime um **Resumo** com
`[ok]` ou `[x]` em cada item.

- Se algum item vier `[x]`, leia a dica impressa logo abaixo dele, resolva e rode
  `npm run setup` de novo (ele pode rodar quantas vezes precisar).
- Linux: se o Chromium falhar, rode o comando `install-deps` que a própria dica mostra.

**Pronto quando:** a última linha é `Tudo pronto. Agora rode:  npm start`.

## Passo 5 — Subir tudo

Rode **em segundo plano**, guardando a saída:

```bash
npm start
```

Ele sobe três coisas juntas: o painel, o scraper Python e um túnel HTTPS. Em até ~1 minuto
aparecem no terminal:

- `painel no ar: http://localhost:3100` (a porta pode ser outra se a 3100 estiver ocupada:
  use a que aparecer);
- `scraper pronto: http://127.0.0.1:8100`;
- `URL pública (cloudflared): https://….trycloudflare.com` e um quadro com as duas URLs para
  o Mercado Livre.

O navegador abre sozinho no painel. Se não abrir, passe o link ao aluno.

**Pronto quando:** `curl -s http://127.0.0.1:3100/api/ping` devolve `{"ok":true,"app":"aula-ml"}`
(troque a porta se for outra) e o quadro com as URLs apareceu.

Se aparecer `O painel já está rodando`, ele já estava de pé: só abra o link.

## Passo 6 — Acompanhar o aluno no painel

Mostre ao aluno as duas URLs do quadro e guie, uma etapa por vez:

1. **Criar a senha do painel** — na primeira tela, com pelo menos 8 caracteres. Ele deve
   anotar: não tem "esqueci a senha" por e-mail.
2. **Criar o aplicativo no Mercado Livre** — a tela **Configurações** (no menu do topo) mostra as duas URLs com
   botão de copiar e um "Passo a passo" com o que marcar no DevCenter
   (https://developers.mercadolivre.com.br/devcenter):
   - URIs de redirect → a URL que termina em `/callback`;
   - URL de notificações → a que termina em `/webhook`;
   - Fluxos OAuth → **Authorization Code**, **Client Credentials** e **Refresh Token**;
   - Permissões → leitura e escrita em *Publicação e sincronização*;
   - salvar.
3. **Colar App ID e chave secreta no painel** (passo 2 da tela Configurações — não no chat).
   O painel confere com o Mercado Livre e diz se está certo.
4. **Conectar a conta** — botão no passo 3. O aluno faz login no Mercado Livre no navegador
   dele e volta para o painel com a conta conectada.
5. **Login do scraper** — aba **Navegador** → **Fazer login**. O aluno digita a senha do
   Mercado Livre na própria tela.

**Pronto quando:** a tela Configurações mostra o passo 3 concluído (conta listada) e o
scraper como **rodando**.

**Perguntar em vez de procurar:** ainda na tela Configurações, o bloco **Claude Code** mostra a
pasta do projeto e uma linha pronta para colar no Terminal. Com ela o aluno abre o Claude Code
já ligado aos anúncios dele e pergunta em português ("quais meus melhores produtos dos últimos
30 dias?"). Aponte o bloco ao aluno; o passo a passo está lá.

**Usar de qualquer lugar:** mostre ao aluno o **Endereço público** da tela Configurações (é a
mesma URL do túnel). Aberto no celular ou em outro computador, ele pede a mesma senha. Avise
que esse endereço muda quando o painel é reiniciado, e que a senha só pode ser criada no
computador onde o painel está instalado.

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| Terminal mostra **"A URL PÚBLICA MUDOU"** | Acontece depois de `npm run parar`, de reiniciar o computador ou de o túnel cair. Aluno copia as URLs novas da tela Configurações para o app no DevCenter, salva e clica **Verificar de novo**. |
| Tela do ML: "não foi possível conectar o aplicativo" | Conferir se o app foi **salvo** no DevCenter; conta de colaborador não autoriza; pendência de cadastro no ML bloqueia. |
| Aparece "Tunnel website ahead!" | O túnel caiu no plano B: digitar o IP que a própria página mostra e continuar. Ver `logs/tunel.log`. |
| Túnel não abre | Ler `logs/tunel.log`. Rede corporativa pode bloquear a porta 7844: testar outra rede (ex.: celular). |
| Scraper "reiniciando" sem parar | Ler `logs/scraper.log`; normalmente é o Chromium: `npm run setup`. |
| "Node … é antigo demais" | Atualizar o Node (Passo 2) e repetir `npm run setup`. |
| Erro que o professor diz já ter corrigido (ex.: "Parece que esta página no existe" ao fazer login no scraper) | `npm run atualizar`, depois `Ctrl+C` no `npm start` e `npm start` de novo. Se `atualizar` não existir (cópia muito antiga): `git pull https://github.com/ElioBonfim/Aula-Mercado-Livre-Henrique-Niada.git main`. |

Para reiniciar depois de mudar código: `Ctrl+C` no `npm start` e rode `npm start` de novo —
a URL pública continua a mesma. Para fechar tudo, túnel incluído: `npm run parar` (a próxima
URL será nova). Para voltar outro dia: entrar na pasta e rodar `npm start` de novo.

Mais detalhes: `README.md` do repositório.
