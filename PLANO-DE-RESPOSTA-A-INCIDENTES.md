# Plano de resposta a incidentes de segurança

Vale para o painel de gestão (este projeto), o computador onde ele roda e as contas de
marketplace ligadas a ele (Amazon, Mercado Livre, Shopee, Magalu, Leroy Merlin).

Versão 1 — aprovado em (data). Próxima revisão obrigatória: 6 meses depois.

## 1. Funções

| Função | Quem | O que faz |
|---|---|---|
| Responsável pelo incidente | (preencher: nome e função) | Decide, executa a contenção, comunica Amazon e demais marketplaces, registra o incidente |
| Substituto | (preencher: pessoa de confiança da empresa) | Assume se o responsável estiver indisponível por mais de 4 horas |

Contato de segurança da Amazon: **security@amazon.com** (e o caso aberto no Seller Central).

## 2. O que é incidente

- Acesso ao painel ou ao computador por pessoa não autorizada (login estranho, sessão que
  não foi sua, aviso de tentativas de senha).
- Perda, roubo ou invasão do computador do painel ou do celular com o código de 2 etapas.
- Vírus/malware detectado pelo Kaspersky no computador do painel.
- Vazamento ou suspeita de vazamento de senha, chave de API ou token (Amazon, ML, Shopee etc.).
- Qualquer exposição de dados da Amazon a quem não deveria ter acesso.

## 3. Passo a passo

1. **Detectar e registrar (imediato):** anote data/hora, o que foi visto e onde (tabela no fim).
2. **Conter (até 1 hora):**
   - Desligue o painel (`Ctrl+C` no `npm start`; `npm run parar` fecha também o túnel).
   - Desconecte o computador da internet se houver suspeita de invasão.
   - Revogue o acesso do aplicativo: Amazon (Seller Central → Gerenciar seus apps → revogar /
     gerar novo segredo LWA), Mercado Livre (DevCenter → renovar chave secreta), Shopee e demais.
   - Troque a senha do painel, do Windows, do Seller Central e do e-mail.
   - Celular perdido: `npm run desativar-2fa` e reative no celular novo.
3. **Avisar a Amazon (até 24 horas da detecção):** se o incidente envolver ou puder envolver
   informações da Amazon, mandar e-mail para **security@amazon.com** com: o que aconteceu,
   quando foi detectado, quais dados podem ter sido afetados e o que já foi feito.
   Avisar também os outros marketplaces afetados pelos canais deles.
4. **Eliminar e recuperar:** varredura completa do Kaspersky, atualizar Windows e o painel,
   só religar com senhas e chaves novas.
5. **Depois do incidente (até 7 dias):** registrar a causa e o que muda para não repetir.

## 4. Revisão a cada 6 meses

A cada 6 meses (e depois de qualquer incidente), o responsável revisa este plano e confere:

- Kaspersky ativo e atualizado (antivírus e Bloqueador de Ataques de Rede), firewall ligado.
- Windows atualizado; política de senha (12+ caracteres, complexidade, 365 dias) valendo.
- Painel com 2 etapas ativo e senha dentro da validade (Configuração → Segurança).
- Rede de convidados isolada; só o computador do painel na rede principal.
- Lista de quem tem acesso ao painel e às contas (remover quem não precisa mais).

## Registro de revisões

| Data | Quem | Observações |
|---|---|---|
| (data) | (quem) | Versão 1 criada |

## Registro de incidentes

| Data/hora detecção | O que aconteceu | Dados afetados | Amazon avisada em | Ações |
|---|---|---|---|---|
| | | | | |
