// Builds the iPhone/web version into ./site
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'site');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
let h = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
const ver = require(path.join(root, 'package.json')).version;
h = h.replace('<html lang="en">', '<html lang="en" class="web">')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="White Glove"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="theme-color" content="#fafafa"><link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="apple-touch-icon.png">')
  .replace("img-src 'self' data:\"", "img-src 'self' data:; connect-src 'self' https:; worker-src 'self'\"")
  .replace('<script src="xlsx.full.min.js"></script>', '<script src="config.js"></script><script src="webwg.js"></script><script src="xlsx.full.min.js"></script>')
  .replace('</style>', fs.readFileSync(path.join(__dirname, 'mobile.css'), 'utf8') + '\n</style>');
if (!h.includes('webwg.js') || !h.includes('connect-src') || !h.includes('manifest')) throw new Error('build patch failed');
fs.writeFileSync(path.join(out, 'index.html'), h);
fs.copyFileSync(path.join(root, 'app', 'xlsx.full.min.js'), path.join(out, 'xlsx.full.min.js'));
for (const f of ['config.js', 'webwg.js', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(out, f));
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(out, 'sw.js'), 'utf8').replace("'wg-shell-v1'", "'wg-shell-" + ver + "'"));
console.log('built web v' + ver);
