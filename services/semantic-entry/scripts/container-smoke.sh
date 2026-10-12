#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
trap 'docker rm -f jopie-semantic-entry-smoke >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name jopie-semantic-entry-smoke -p 127.0.0.1:55808:8080 -v "$PWD/services/semantic-entry/scripts/smoke-server.mjs:/tmp/smoke-server.mjs:ro" jopie-semantic-entry node /tmp/smoke-server.mjs >/dev/null
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base='http://127.0.0.1:55808';
for(let i=0;i<30;i++){try{if((await fetch(`${base}/healthz`)).status===200){break;}}catch{} await new Promise(r=>setTimeout(r,1000));}
assert.equal((await fetch(`${base}/healthz`)).status,200);
const requestId='12345678-1234-4123-8123-123456789abc';
const post=(body,auth=true)=>fetch(`${base}/semantic-entry`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer synthetic'}:{})},body:JSON.stringify(body)});
assert.equal((await post({requestId,text:'synthetic lunch 100'},false)).status,401);
assert.equal((await post({requestId,text:'synthetic lunch 100',userId:'a'})).status,400);
const created=await post({requestId,text:'synthetic lunch 100'});assert.equal(created.status,200);assert.equal((await created.json()).status,'created');
const status=await fetch(`${base}/semantic-entry/${requestId}`,{headers:{Authorization:'Bearer synthetic'}});assert.equal(status.status,200);assert.equal((await status.json()).status,'not_found');
console.log('Container smoke: healthz200, missing-token401, extra-field400, mock-created200, GET not_found200');
JS
