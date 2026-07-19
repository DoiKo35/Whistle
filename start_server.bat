@echo off
title Whistle Messenger - Server Startup
cls

echo ===================================================
echo  Запуск сервера Whistle и туннеля LocalTunnel...
echo ===================================================

:: 1. Настройки (поменяйте PORT, если ваш сервер работает не на 5000)
set PORT=3000
set SUBDOMAIN=ninety-camels-bet

echo [1/2] Запуск туннеля в отдельном окне...
:: Запускаем localtunnel параллельно. cmd /k оставит окно открытым, если что-то пойдет не так.
start "Whistle Tunnel" cmd /k "lt --port %PORT% --subdomain %SUBDOMAIN%"

:: Небольшая пауза в 2 секунды, чтобы туннель успел инициироваться
timeout /t 2 >nul

echo [2/2] Запуск Node.js сервера...
cd server
node server.js

pause