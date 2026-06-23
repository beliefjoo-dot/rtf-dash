@echo off
chcp 65001 > nul
cd /d "%~dp0"

set PORT=8787
set URL=http://127.0.0.1:%PORT%/index.html

echo RTF Dashboard를 로컬 서버 모드로 엽니다.
echo 주소: %URL%
echo.

start "RTF local server" /min node -e "const http=require('http'),fs=require('fs'),path=require('path');const root=process.cwd();const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsm':'application/vnd.ms-excel.sheet.macroEnabled.12','.xls':'application/vnd.ms-excel'};http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');let p=decodeURIComponent(u.pathname);if(p==='/'||p==='')p='/index.html';const f=path.normalize(path.join(root,p));if(!f.startsWith(root)){res.writeHead(403);return res.end('Forbidden');}fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':types[path.extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});res.end(d);});}).listen(%PORT%,'127.0.0.1');"
timeout /t 2 > nul
start "" "%URL%"
