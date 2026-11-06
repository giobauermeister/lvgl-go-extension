// Test-only certificates; never installed or trusted on the development machine.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, readFile, writeFile, chmod, access } = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const { X509Certificate } = require('node:crypto');

const run = promisify(execFile);

async function createDevelopmentCertificate(directory, hosts) {
  const names = [...new Set(['localhost', '127.0.0.1', ...hosts])];
  for (const name of names) {
    if (!isIP(name) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(name)) throw new Error(`Invalid certificate host: ${name}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ca = path.join(directory, 'root-ca.pem');
  const caKey = path.join(directory, 'root-key.pem');
  const cert = path.join(directory, 'server.pem');
  const key = path.join(directory, 'server-key.pem');
  const rootConfig = path.join(directory, 'root.cnf');
  const leafConfig = path.join(directory, 'server.cnf');
  const csr = path.join(directory, 'server.csr');
  const caDer = path.join(directory, 'root-ca.cer');
  const exists = async (file) => access(file).then(() => true, () => false);
  const hasCa = await exists(ca), hasCaKey = await exists(caKey);
  if (hasCa !== hasCaKey) throw new Error('The development CA is incomplete. Restore its certificate/key together or choose a new certificate directory.');
  const openssl = (args) => run('openssl', args, { timeout: 30000, windowsHide: true });
  if (!hasCa) {
    await writeFile(rootConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=LVGL Go Development CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
    await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', caKey, '-out', ca, '-config', rootConfig]);
    if (process.platform !== 'win32') await chmod(caKey, 0o600);
  }
  const san = names.map(name => `${isIP(name) ? 'IP' : 'DNS'}:${name}`).join(',');
  await writeFile(leafConfig, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=LVGL Go Local Preview', '-keyout', key, '-out', csr]);
  if (process.platform !== 'win32') await chmod(key, 0o600);
  await openssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '30', '-sha256', '-extfile', leafConfig]);
  await openssl(['x509', '-in', ca, '-outform', 'DER', '-out', caDer]);
  const fingerprint = new X509Certificate(await readFile(ca)).fingerprint256;
  return { cert, key, ca, caDer, fingerprint, hosts: names };
}

module.exports = { createDevelopmentCertificate };
