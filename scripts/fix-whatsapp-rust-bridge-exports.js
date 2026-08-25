// baileys depends on whatsapp-rust-bridge, which ships an ESM-only "exports" map
// (only an "import" condition, no "require"/"default"). This project runs as
// CommonJS (tsx/node `require()`), so without this fix the process crashes at
// startup with ERR_PACKAGE_PATH_NOT_EXPORTED as soon as baileys is loaded.
// This runs on postinstall (patch-package's own diff/apply was unreliable for
// this particular file, so we just patch the JSON directly - it's idempotent).
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-rust-bridge', 'package.json');

if (!fs.existsSync(pkgPath)) {
  // Not installed (e.g. a baileys version that no longer depends on it) - nothing to do.
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const exportsEntry = pkg.exports?.['.'];

if (!exportsEntry) {
  process.exit(0);
}

if (exportsEntry.require && exportsEntry.default) {
  // Already patched.
  process.exit(0);
}

exportsEntry.require = exportsEntry.require || './dist/index.js';
exportsEntry.default = exportsEntry.default || './dist/index.js';

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
console.log('[fix-whatsapp-rust-bridge-exports] Patched whatsapp-rust-bridge exports for CJS compatibility.');
