@echo off
cd /d "%~dp0"
"runtime\node.exe" "baslat.cjs"
if errorlevel 1 (
  echo Program baslatilamadi. work klasorundeki hata kaydini kontrol edin.
  pause
)
