@echo off
title Sistema de Asistencia y Horas Acumuladas - Congreso
echo ============================================================
echo   INICIANDO SISTEMA DE ASISTENCIA CONGRESO (QR + HORAS)
echo ============================================================
echo.
start "" "http://localhost:3000/admin"
node --no-warnings server.js
pause
