@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Buddyfight - local / relay server
echo  ローカル対戦サーバー
echo ============================================
echo URL: http://127.0.0.1:4173/index.html
echo (server window opens separately; close it to stop)
echo.
start "Buddyfight local server" cmd /k "powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 -Port 4173"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:4173/index.html"
echo.
echo ブラウザが開きます。「繋がらない」場合はサーバー窓の起動を待って F5 で再読み込みしてください。
echo （別ウィンドウのサーバー窓を閉じると終了します）
timeout /t 3 /nobreak >nul
