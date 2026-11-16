@echo off
title Publicar Sistema de Asistencia en Internet (HTTPS)
echo ====================================================================
echo   PUBLICANDO SISTEMA DE ASISTENCIA EN INTERNET (MODO TUNEL SEGURO)
echo ====================================================================
echo.
echo 1. Iniciando servidor local en el puerto 3000...
start "Servidor Asistencia Congreso" cmd /k "node --no-warnings server.js"
timeout /t 2 /nobreak >nul

echo 2. Creando enlace publico HTTPS para que cualquier celular entre con datos moviles...
echo    (Copia el enlace que termina en .trycloudflare.com que aparecera en el recuadro)
echo.
npx --yes cloudflared tunnel --url http://localhost:3000
pause
