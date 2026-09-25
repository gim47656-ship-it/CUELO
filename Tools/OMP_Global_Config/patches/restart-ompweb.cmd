@echo off
rem Restart CUELO from outside the CUELO process tree.
rem Interactive: Win+R, then %USERPROFILE%\.omp\restart-ompweb.cmd
rem Scheduled: schtasks /run /tn CUELO-Restart
title CUELO restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-ompweb.ps1"
exit /b %errorlevel%
