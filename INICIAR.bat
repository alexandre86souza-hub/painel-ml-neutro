@echo off
chcp 65001 >nul
title Painel do Vendedor - ligado (nao feche esta janela)
cd /d "%~dp0"
echo.
echo ============================================================
echo   Painel do Vendedor
echo   Esta janela precisa ficar ABERTA enquanto voce usa o painel.
echo   Para desligar: aperte Ctrl+C nesta janela.
echo ============================================================
echo.
call npm start
echo.
pause
