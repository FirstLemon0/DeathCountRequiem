@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Buddyfight - online (authoritative) server
echo  オンライン対戦サーバー（権威・手札秘匿/観戦）
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found / Node.js が見つかりません。
  echo Install the LTS from https://nodejs.org and run again.
  echo https://nodejs.org の LTS 版を入れてから、もう一度実行してください。
  echo.
  pause
  exit /b 1
)
echo サーバー窓が別に開き、数秒後に自動でブラウザが開きます。
echo ポートが予約済み/使用中の場合は自動で別ポートに切り替わります（実URLはサーバー窓に表示）。
echo （サーバー窓を閉じると終了します。エラー時はその窓に内容が表示されます）
echo.
start "Buddyfight online server" cmd /k "node server\authoritative-server.js --host 127.0.0.1 --port 4174 --open"
timeout /t 3 /nobreak >nul
