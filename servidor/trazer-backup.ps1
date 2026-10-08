# Traz a cópia de segurança mais nova do banco do SERVIDOR para uma pasta deste computador (ex.: OneDrive),
# e guarda só as últimas N. Feito para rodar todo dia pelo Agendador de Tarefas (servidor/SERVIDOR.md).
#   powershell -NoProfile -ExecutionPolicy Bypass -File servidor\trazer-backup.ps1 -Servidor IP -Pasta "C:\...\OneDrive\Backup Painel"
# Usa a chave SSH deste computador (sem senha). A cópia do servidor é feita 1x/dia pelo próprio painel (backup.js).
param(
  [Parameter(Mandatory = $true)][string]$Servidor,
  [Parameter(Mandatory = $true)][string]$Pasta,
  [int]$Guardar = 30
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Pasta | Out-Null
$log = Join-Path $Pasta 'trazer-backup.log'
function Anotar($t) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $t" | Add-Content -Path $log -Encoding utf8 }
try {
  $ultima = (ssh -o BatchMode=yes -o ConnectTimeout=20 "root@$Servidor" 'ls -t /home/painel/app/backups/painel-*.sqlite | head -1').Trim()
  if (-not $ultima) { throw 'o servidor não tem cópia ainda' }
  $nome = Split-Path $ultima -Leaf
  $destino = Join-Path $Pasta $nome
  if (Test-Path $destino) { Anotar "já tinha $nome"; exit 0 }
  scp -q -o BatchMode=yes "root@${Servidor}:$ultima" "$destino.parcial"
  if ($LASTEXITCODE -ne 0) { throw "scp saiu com $LASTEXITCODE" }
  Move-Item -Force "$destino.parcial" $destino
  # só as últimas N
  Get-ChildItem $Pasta -Filter 'painel-*.sqlite' | Sort-Object Name -Descending | Select-Object -Skip $Guardar | Remove-Item -Force
  Anotar ("trouxe $nome ({0:N1} MB)" -f ((Get-Item $destino).Length / 1MB))
} catch {
  Anotar "ERRO: $($_.Exception.Message)"
  exit 1
}
