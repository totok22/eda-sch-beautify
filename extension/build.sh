#!/bin/sh
# 构建：主入口 dist/index.js + 内联脚本的 iframe/panel.html，然后打包 .eext
set -e
cd "$(dirname "$0")"
node_modules/.bin/rimraf ./dist
node_modules/.bin/tsx ./config/esbuild.prod.ts
node_modules/.bin/esbuild src/iframe-app.ts --bundle --format=iife --target=es2019 --minify --outfile=/tmp/sch-beautify-panel.js --log-level=warning
mkdir -p iframe
node -e "const fs=require('fs');const js=fs.readFileSync('/tmp/sch-beautify-panel.js','utf8').replace(/<\/script/gi,'<\\\\/script');fs.writeFileSync('iframe/panel.html',fs.readFileSync('src/panel.html','utf8').replace('<script src=\"panel.js\"></script>',()=>'<script>'+js+'</script>'))"
node_modules/.bin/tsx ./build/packaged.ts
cp build/dist/*.eext dist/
