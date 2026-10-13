#!/usr/bin/env bash
# Envia o código deste computador para o servidor e reinicia o painel lá (Git Bash):
#   bash servidor/publicar.sh IP_DO_SERVIDOR
# Vai o ÚLTIMO COMMIT (git archive): .env, banco, logs e a sessão do scraper nunca saem daqui por este caminho.
set -euo pipefail
HOST="${1:?uso: bash servidor/publicar.sh IP_DO_SERVIDOR}"
cd "$(dirname "$0")/.."
# Extrai como o usuário painel (nunca root numa pasta que ele controla: um link simbólico plantado ali faria o
# root gravar arquivos do sistema) e confere antes que a pasta não é link.
git archive --format=tar HEAD | ssh "root@$HOST" 'test -d /home/painel/app && ! test -L /home/painel/app || { echo "/home/painel/app não é uma pasta normal: pare e confira"; exit 1; }; sudo -u painel tar -x --no-same-owner --no-same-permissions -C /home/painel/app && systemctl restart painel && sleep 3 && systemctl --no-pager --lines=5 status painel'
