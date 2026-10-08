#!/usr/bin/env bash
# Prepara um Ubuntu 24.04 NOVO para o painel rodar 24 h com domínio próprio (ver servidor/SERVIDOR.md).
# Rodar como root, uma vez:   bash instalar-vps.sh painel.seudominio.com.br
#
# O que faz: atualizações automáticas de segurança, firewall (só SSH, 80 e 443), fail2ban, SSH só por
# chave, Node 22, Caddy (HTTPS automático do Let's Encrypt na frente da porta pública 3101), tela
# virtual (Xvfb) para o navegador do scraper e o serviço "painel" (usuário sem privilégio, reinicia
# sozinho). O painel local (3100) continua só em 127.0.0.1: o administrador chega nele por túnel SSH.
set -euo pipefail
DOMINIO="${1:?uso: bash instalar-vps.sh painel.seudominio.com.br}"
APP=/home/painel/app
export DEBIAN_FRONTEND=noninteractive

echo "== pacotes"
apt-get update
apt-get -y upgrade
apt-get install -y curl git ufw fail2ban unattended-upgrades sqlite3 xvfb gnupg debian-keyring debian-archive-keyring apt-transport-https
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Node 22"
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "== usuário do painel"
id painel >/dev/null 2>&1 || useradd -m -s /bin/bash painel
mkdir -p "$APP" && chown painel: "$APP"

echo "== firewall e SSH só por chave"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
if [ -s /root/.ssh/authorized_keys ]; then
  # 00- vem antes do 50-cloud-init.conf (no sshd vale a 1ª linha encontrada)
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-painel.conf
  systemctl reload ssh
else
  echo "AVISO: /root/.ssh/authorized_keys vazio: a senha do SSH continua ligada. Cadastre a chave e rode de novo."
fi
systemctl enable --now fail2ban

echo "== HTTPS (Caddy)"
# Cf-Connecting-Ip sai: o painel o usa como IP do cliente (limite de tentativas do login) e aqui
# não há Cloudflare na frente — quem mandasse o cabeçalho escolheria o próprio IP.
cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:3101 {
		header_up -Cf-Connecting-Ip
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "== tela virtual para o navegador do scraper (login no ML pela tela Navegador)"
cat > /etc/systemd/system/xvfb.service <<'EOF'
[Unit]
Description=Tela virtual (Xvfb :99) para o Chromium do scraper
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x900x24 -nolisten tcp
Restart=always
User=painel
[Install]
WantedBy=multi-user.target
EOF

echo "== serviço do painel"
cat > /etc/systemd/system/painel.service <<EOF
[Unit]
Description=Painel (Mercado Livre, Shopee, Amazon, Leroy, Magalu)
After=network-online.target xvfb.service
Wants=network-online.target xvfb.service
[Service]
User=painel
WorkingDirectory=$APP
Environment=DISPLAY=:99
Environment=ABRIR_NAVEGADOR=0
Environment=PATH=/home/painel/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning iniciar.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now xvfb
systemctl enable painel   # só liga depois da migração (servidor/SERVIDOR.md, passo 4)

echo
echo "Pronto. Próximo: enviar o código e os dados deste computador (servidor/SERVIDOR.md)."
