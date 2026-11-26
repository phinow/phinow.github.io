import * as esbuild from 'esbuild';
import fs from 'fs';

const result = await esbuild.build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome90', 'safari15', 'firefox90'],
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const app = result.outputFiles[0].text;
const modelJSON = JSON.parse(fs.readFileSync('node_modules/@spotify/basic-pitch/model/model.json', 'utf8'));
delete modelJSON.weightsManifest[0].paths;
const weights = fs.readFileSync('node_modules/@spotify/basic-pitch/model/group1-shard1of1.bin').toString('base64');
const demo = fs.readFileSync('data/demo_notes.json', 'utf8');
const stretch = fs.readFileSync('node_modules/signalsmith-stretch/SignalsmithStretch.js', 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const data = `var MODEL_JSON=${JSON.stringify(modelJSON)};var MODEL_B64="${weights}";var DEMO_NOTES=${demo};`;
let html = fs.readFileSync('src/template.html', 'utf8');
html = html.replace('<script>/*__DATA__*/</script>', () => `<script>${safe(data)}</script>\n<script>${safe(stretch)}</script>`);
html = html.replace('<script>/*__APP__*/</script>', () => `<script>${safe(app)}</script>`);
// The page's other files (ort/, models/, piano/, demo.mp3, coi-serviceworker.min.js) live next to
// index.html in the keyshift folder and are not touched by the build.
fs.writeFileSync('../index.html', html);
console.log('app', (app.length / 1024).toFixed(0) + 'KB', 'total', (html.length / 1024 / 1024).toFixed(2) + 'MB');
