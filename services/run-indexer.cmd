@echo off
setlocal
set NODE_TLS_REJECT_UNAUTHORIZED=0
cd /d "%~dp0"
npm.cmd run sync -- --network coston2
