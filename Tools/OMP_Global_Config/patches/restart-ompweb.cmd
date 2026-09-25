@echo off
rem Restart omp-web from outside the omp-web process tree.
rem Interactive: Win+R, then %USERPROFILE%\.omp\restart-ompweb.cmd
rem Scheduled: schtasks /run /tn OMPWEB-Restart
title OMPWEB restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-ompweb.ps1"
exit /b %errorlevel%
