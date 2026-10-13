// License ki chaabi (Ed25519) — SIRF EK BAAR chalao, tumhare PC pe.
//   npm run license-keygen
// PRIVATE key -> Supabase Edge Function secret (LICENSE_PRIVATE_KEY). Kisi ko mat dena, code me mat daalna.
// PUBLIC key  -> src/license/pubkey.js me apne aap likh di jaati hai (app isi se token jaanchta hai).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('src', 'license', 'pubkey.js');
if (fs.existsSync(out) && !/REPLACE_ME/.test(fs.readFileSync(out, 'utf8')) && process.argv[2] !== '--force') {
  console.log('Public key pehle se bani hai (src/license/pubkey.js). Nayi chaabi = sab dealers ko dobara login. Pakka? to: npm run license-keygen -- --force');
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(out, `// npm run license-keygen ne banaya — badlo mat\nexport const LICENSE_PUBLIC_KEY = \`${pub.trim()}\`;\n`);
console.log('\n✓ Public key likh di: src/license/pubkey.js\n');
console.log('=== PRIVATE KEY (Supabase → Edge Functions → Secrets → LICENSE_PRIVATE_KEY) ===\n');
console.log(priv);
console.log('\nIse kahin safe rakh lo. Chat/WhatsApp pe mat bhejna.\n');
