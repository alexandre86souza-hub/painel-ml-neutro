@echo off
chcp 65001 >nul
title Painel do Vendedor - Instalacao
cd /d "%~dp0"
echo.
echo ============================================================
echo   Painel do Vendedor - instalacao
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [x] O Node.js nao esta instalado.
  echo     Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
  echo     Veja o capitulo 2 do Guia de Instalacao.
  echo.
  pause
  exit /b 1
)
echo Node.js encontrado:
node -v
echo.
echo [1/2] Instalando as dependencias (npm install)...
call npm install
if errorlevel 1 goto erro
echo.
echo [2/2] Preparando o painel, o scraper e o navegador (npm run setup)...
echo       Pode levar alguns minutos na primeira vez.
call npm run setup
if errorlevel 1 goto erro
echo.
echo ============================================================
echo   Instalacao concluida.
echo   Para ligar o painel, de dois cliques em INICIAR.bat
echo ============================================================
echo.
pause
exit /b 0
:erro
echo.
echo [x] Algo falhou. Leia a mensagem acima e o capitulo
echo     "Problemas comuns" do Guia de Instalacao.
echo     Depois de corrigir, rode este arquivo de novo.
echo.
pause
exit /b 1
