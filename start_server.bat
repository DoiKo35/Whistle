@echo off
title Whistle Server
cls

echo ===================================================
echo  Starting Whistle Server and Ngrok...
echo ===================================================

:: SETTINGS
set PORT=3000
set NGROK_URL=corned-halt-untapped.ngrok-free.dev

:: LOCATING NGROK AND SERVER
cd server

echo [1/2] Starting Ngrok...
:: STARTING NGROK
start "Whistle Tunnel" cmd /k "ngrok.exe http %PORT% --url=%NGROK_URL%"

:: TIMEOUT
timeout /t 2 >nul

echo [2/2] Starting Whistle Server...
:: STARTING WHISTLE SERVER
node server.js

pause