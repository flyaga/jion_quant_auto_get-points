@echo off
rem cd /d F:\flyaga\dev\joinquant-auto-skill
cd /d "%~dp0"
set JQ_ACCOUNTS=改成你的聚宽账号，可以多个账号用逗号隔开，不过要你的多个账号的密码一致才行，密码不一致需要自己修改代码
set JQ_PASSWORD=改成你的聚宽密码
set "today=alock.%DATE:~8,2%"

for /f "delims=" %%F in ('dir /b /a-d alock.* 2^>nul') do @if /i not "%%~nxF"=="%today%" del /f /q "%%F"

if exist "%today%" (
    echo find "%today%" file ok, skip
) else (
    node scripts\claim.js
    type nul > "%today%"
    echo create empty file "%today%" ok
)



