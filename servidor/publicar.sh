#!/usr/bin/env bash
# Envia o código deste computador para o servidor e reinicia o painel lá (Git Bash):
#   bash servidor/publicar.sh IP_DO_SERVIDOR
# Vai o ÚLTIMO COMMIT (git archive): .env, banco, logs e a sessão do scraper nunca saem daqui por este caminho.
set -euo pipefail
HOST="${1:?uso: bash servidor/publicar.sh IP_DO_SERVIDOR}"
cd "$(dirname "$0")/.."
git archive --format=tar HEAD | ssh "root@$HOST" 'tar -x -C /home/painel/app && chown -R painel: /home/painel/app && systemctl restart painel && sleep 3 && systemctl --no-pager --lines=5 status painel'
