@echo off
:: ShelfRx Agent — Installateur Windows
:: ======================================
:: Ce script installe l'agent ShelfRx comme un service Windows qui démarre
:: automatiquement. Nécessite d'être lancé en tant qu'Administrateur.

setlocal EnableDelayedExpansion

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   ShelfRx Agent — Installation          ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Check administrator rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ❌ Ce script doit être lancé en tant qu'Administrateur.
    echo     Clic droit → "Exécuter en tant qu'administrateur"
    pause
    exit /b 1
)

:: Determine installation directory
set INSTALL_DIR=%ProgramFiles%\ShelfRx
set APPDATA_DIR=%APPDATA%\ShelfRx
set SERVICE_NAME=ShelfRxAgent

echo  📁 Répertoire d'installation : %INSTALL_DIR%
echo  📁 Répertoire de données     : %APPDATA_DIR%
echo.

:: Create directories
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%APPDATA_DIR%" mkdir "%APPDATA_DIR%"

:: Copy agent executable
echo  📦 Copie de l'agent...
copy /Y "%~dp0shelfrx-agent.exe" "%INSTALL_DIR%\shelfrx-agent.exe" >nul
if %errorLevel% neq 0 (
    echo  ❌ Erreur lors de la copie de shelfrx-agent.exe
    echo     Assurez-vous que le fichier est présent dans le même dossier que ce script.
    pause
    exit /b 1
)

:: Create default config if it doesn't exist
if not exist "%APPDATA_DIR%\config.json" (
    echo  ⚙️  Création de la configuration par défaut...
    (
        echo {
        echo   "pn13_port": 5013,
        echo   "cloud_url": "https://shelfrx.polsia.app",
        echo   "pharmacy_key": "",
        echo   "lgo": "winpharma",
        echo   "debug": false
        echo }
    ) > "%APPDATA_DIR%\config.json"
    echo.
    echo  ⚠️  IMPORTANT : Avant de démarrer l'agent, ouvrez le fichier de config :
    echo     %APPDATA_DIR%\config.json
    echo     et renseignez votre "pharmacy_key" depuis ShelfRx ^(Connexion Stock → Agent PN13^)
    echo.
)

:: Remove existing service if present
sc query %SERVICE_NAME% >nul 2>&1
if %errorLevel% equ 0 (
    echo  🔄 Mise à jour du service existant...
    sc stop %SERVICE_NAME% >nul 2>&1
    sc delete %SERVICE_NAME% >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Install as Windows service using sc.exe
echo  ⚙️  Installation du service Windows...
sc create %SERVICE_NAME% ^
    binpath= "\"%INSTALL_DIR%\shelfrx-agent.exe\"" ^
    start= auto ^
    DisplayName= "ShelfRx Agent - Synchronisation Stock" ^
    description= "Capture les mouvements de stock via PN13 et les synchronise avec ShelfRx"

if %errorLevel% neq 0 (
    echo  ❌ Erreur lors de la création du service.
    echo     Essayez de désinstaller d'abord avec : sc delete %SERVICE_NAME%
    pause
    exit /b 1
)

:: Configure service recovery (auto-restart on failure)
sc failure %SERVICE_NAME% reset= 86400 actions= restart/5000/restart/10000/restart/30000 >nul

:: Open config file for editing
echo.
echo  📝 Ouverture du fichier de configuration...
echo     Renseignez votre pharmacy_key puis sauvegardez.
echo.
start notepad "%APPDATA_DIR%\config.json"

echo  ──────────────────────────────────────────────
echo  ✅ Installation terminée !
echo.
echo  Commandes utiles :
echo    Démarrer  : sc start %SERVICE_NAME%
echo    Arrêter   : sc stop %SERVICE_NAME%
echo    Statut    : sc query %SERVICE_NAME%
echo    Logs      : %APPDATA_DIR%\agent.log
echo.
echo  Après avoir renseigné votre pharmacy_key, démarrez le service :
echo    sc start %SERVICE_NAME%
echo.
pause
