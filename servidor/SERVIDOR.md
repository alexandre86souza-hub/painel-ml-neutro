# Painel no servidor (VPS) com domínio próprio

Painel 24 h em `https://painel.SEUDOMINIO` sem depender do computador do escritório. Testado para
Ubuntu 24.04 (Hostinger KVM 2). Comandos de "este computador" no Git Bash; `IP` = IP do servidor.

## 1. Servidor e domínio

1. VPS Ubuntu 24.04, chave SSH pública deste computador (`~/.ssh/id_ed25519.pub`) cadastrada no painel
   do provedor. A senha de root fica com você (nunca no chat nem no repositório).
2. DNS (Registro.br → domínio → DNS → Editar zona): registro **A**, nome `painel`, valor = IP.
   Conferir: `nslookup painel.SEUDOMINIO` responde o IP.

## 2. Preparar o servidor (uma vez)

```bash
scp servidor/instalar-vps.sh root@IP:/root/
ssh root@IP "bash /root/instalar-vps.sh painel.SEUDOMINIO"
bash servidor/publicar.sh IP          # envia o código (o serviço ainda falha: falta o .env e o setup)
ssh root@IP "su - painel -c 'cd app && npm run setup'"
ssh root@IP "cd /home/painel/app/scraper && /home/painel/.local/bin/uv run playwright install-deps chromium"
```

## 3. Migrar os dados (com o painel deste computador PARADO para sempre)

Dois painéis ligados ao mesmo tempo estragam as conexões: o refresh token da Shopee é de uso único e
as comandas seriam numeradas em dois lugares. Depois da migração, este computador NÃO roda mais `npm start`.

```bash
npm run parar                          # aqui: fecha painel, scraper e túnel
npm run backup                         # cópia conferida do banco em backups/
ssh root@IP "systemctl stop painel"
scp backups/<a-mais-nova>.sqlite root@IP:/home/painel/app/dados.sqlite
scp .env root@IP:/home/painel/app/.env                       # ML_DB_KEY: sem ela os segredos do banco não abrem
scp -r scraper/.sessao_ml root@IP:/home/painel/app/scraper/  # login do ML do scraper
ssh root@IP "cd /home/painel/app && printf '\nURL_PUBLICA=https://painel.SEUDOMINIO\nPORTA_PUBLICA=3101\n' >> .env && chown -R painel: . && chmod 600 .env dados.sqlite"
ssh root@IP "systemctl start painel && journalctl -u painel -n 30 --no-pager"
```

## 4. Trocar o endereço de retorno nos marketplaces

- Mercado Livre (developers): Redirect URI = `https://painel.SEUDOMINIO/callback`, notificações = `/webhook`.
- Shopee (Open Platform): domínio do app = `https://painel.SEUDOMINIO`.
- Amazon Ads (Login with Amazon): Allowed Return URL = `https://painel.SEUDOMINIO/amazon-ads/callback`.
- Magalu: o retorno é `localhost` — só para reconectar: túnel SSH (abaixo) e abrir `http://localhost:3100`.

## Dia a dia

- Atualizar o código: commit aqui e `bash servidor/publicar.sh IP`.
- Administrador (primeiro acesso, Magalu, `desativar-2fa`): `ssh -L 3100:127.0.0.1:3100 root@IP` e abrir
  `http://localhost:3100` neste computador. O painel local nunca fica na internet.
- Logs: `ssh root@IP "journalctl -u painel -f"` e `/home/painel/app/logs/`.
- Cópia de segurança: o painel copia o banco 1x/dia em `/home/painel/app/backups`. Para ter uma cópia FORA do
  servidor, `servidor/trazer-backup.ps1` traz a mais nova para uma pasta (ex.: OneDrive) e guarda as últimas 30;
  agendado no Agendador de Tarefas do Windows ("Painel - trazer backup do servidor", todo dia 12h, roda depois se o
  computador estava desligado). Log: `trazer-backup.log` na própria pasta.
