@echo off
REM ============================================================
REM  Tiro - arranque local
REM  Transcribe, pregunta y crea sin salir de tu equipo.
REM  La primera vez crea un entorno e instala lo necesario.
REM ============================================================
setlocal
title Tiro
cd /d "%~dp0"

set PORT=5240
if not "%~1"=="" set PORT=%~1
set URL=http://127.0.0.1:%PORT%/
set VENV=%~dp0.venv
set VPY=%VENV%\Scripts\python.exe

echo.
echo   TIRO - transcribe, pregunta y crea en local
echo   Servidor en %URL%
echo   (Cierra esta ventana para detenerlo)
echo.

if exist "%VPY%" goto :listo

REM ctranslate2 no publica ruedas para 3.14 todavia, asi que se prefieren
REM las versiones 3.12 / 3.11 / 3.13 / 3.10 antes que el "python" del PATH.
set PY=
for %%V in (3.12 3.11 3.13 3.10) do call :probar_py %%V
if not "%PY%"=="" goto :crear

python -c "import sys; raise SystemExit(0 if (3,9) <= sys.version_info < (3,14) else 1)" >nul 2>nul
if not errorlevel 1 set PY=python
if not "%PY%"=="" goto :crear

echo   No se encontro un Python compatible (hace falta 3.9 - 3.13).
echo   Descarga Python 3.12: https://www.python.org/downloads/release/python-3120/
echo   Marca "Add Python to PATH" y vuelve a ejecutar este archivo.
echo.
pause
goto :eof

:probar_py
if not "%PY%"=="" goto :eof
py -%1 -c "import sys" >nul 2>nul
if not errorlevel 1 set PY=py -%1
goto :eof

:crear
echo   Primera vez: preparando el entorno con %PY% (unos minutos, solo una vez)
echo.
%PY% -m venv "%VENV%"
if not exist "%VPY%" (
    echo   No se pudo crear el entorno virtual.
    pause
    goto :eof
)
"%VPY%" -m pip install --upgrade pip --quiet
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo   Fallo la instalacion de dependencias.
    pause
    goto :eof
)
echo.
echo   Entorno listo.
echo.

:listo
"%VPY%" -m pip install -r requirements.txt --quiet --disable-pip-version-check >nul 2>nul
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo   AVISO: ffmpeg no esta en el PATH. Sin el no se puede leer el audio
    echo   de los videos: https://www.gyan.dev/ffmpeg/builds/
    echo.
)

netstat -ano | findstr /c:"127.0.0.1:%PORT%" | findstr /c:"LISTENING" >nul
if %errorlevel%==0 (
    echo   El puerto %PORT% ya esta en uso: abro la app que ya esta corriendo.
    echo.
    start "" "%URL%"
    pause
    goto :eof
)

"%VPY%" server.py --port %PORT%

echo.
echo   El servidor se detuvo.
pause
