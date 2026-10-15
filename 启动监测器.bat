@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 抄底红线监测器

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，请先安装 Node.js 18 或更高版本。
  echo   下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   抄底红线监测器正在启动...
echo   启动完成后浏览器会自动打开 http://127.0.0.1:8787
echo   关闭本窗口即可停止监测。
echo.

REM 等服务起来后再打开浏览器
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8787/"

node server.mjs

echo.
echo   服务已停止。
pause
