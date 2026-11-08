// Abre una página en Chrome y saca una foto, para revisar con los ojos lo que
// las pruebas no ven: que el diseño entre, que nada se superponga, que los
// textos se lean.
//
//   node tests/mirar.mjs <url> <ancho> <alto> <archivo.png> ["<js a ejecutar>"]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, ancho = '1280', alto = '900', salida = 'captura.png', guion = ''] = process.argv.slice(2);
if (!url) {
  console.error('Falta la dirección.\n  node tests/mirar.mjs http://127.0.0.1:8788/admin/ 390 844 foto.png');
  process.exit(1);
}

const CANDIDATOS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chrome = CANDIDATOS.find(p => p && fs.existsSync(p));
if (!chrome) { console.error('No encontré Chrome instalado.'); process.exit(1); }

const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'mirar-'));
const proceso = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${perfil}`,
  `--window-size=${ancho},${alto}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolver, rechazar) => {
  let acumulado = '';
  const tiempo = setTimeout(() => rechazar(new Error('Chrome no arrancó a tiempo')), 25000);
  proceso.stderr.on('data', d => {
    acumulado += d;
    const m = acumulado.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(tiempo); resolver(m[0]); }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0;
const pendientes = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m); pendientes.delete(m.id); }
};
const enviar = (method, params = {}, sessionId) => new Promise(r => {
  const n = ++id;
  pendientes.set(n, r);
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});

const { result: { targetId } } = await enviar('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await enviar('Target.attachToTarget', { targetId, flatten: true });
const cmd = (m, p) => enviar(m, p, sessionId);

await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', {
  width: Number(ancho), height: Number(alto), deviceScaleFactor: 2, mobile: Number(ancho) < 700,
});
await cmd('Page.navigate', { url });
await new Promise(r => setTimeout(r, 2200));

if (guion) {
  const r = await cmd('Runtime.evaluate', { expression: guion, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value;
  if (r.result?.exceptionDetails) console.log('ERROR en el guion:', r.result.exceptionDetails.text);
  else if (v !== undefined) console.log(JSON.stringify(v, null, 2));
  await new Promise(r2 => setTimeout(r2, 900));
}

// Medir la página entera para que no se corte nada.
const medida = await cmd('Runtime.evaluate', {
  expression: `JSON.stringify({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})`,
  returnByValue: true,
});
const { w, h } = JSON.parse(medida.result.result.value);
await cmd('Emulation.setDeviceMetricsOverride', {
  width: Number(ancho), height: Math.min(h, 7000), deviceScaleFactor: 2, mobile: Number(ancho) < 700,
});
await new Promise(r => setTimeout(r, 500));

const foto = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(salida, Buffer.from(foto.result.data, 'base64'));
console.log(`captura: ${salida} (${ancho}x${Math.min(h, 7000)}, ancho real ${w})`);

ws.close();
proceso.kill();
try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
process.exit(0);
