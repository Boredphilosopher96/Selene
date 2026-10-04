import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Keep private keys outside the checkout, and generate fresh material for every
// fixture. A config file works with both OpenSSL and macOS LibreSSL (-addext does not).
export async function createTemporaryLocalhostTls() {
  const [sourceRoot, temporaryRoot] = await Promise.all([
    realpath(resolve(import.meta.dirname, '..')),
    realpath(tmpdir())
  ]);
  const fromSource = relative(sourceRoot, temporaryRoot);
  if (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) {
    throw new Error('Temporary TLS directory must be outside the source checkout');
  }
  const directory = await mkdtemp(resolve(temporaryRoot, 'selene-localhost-tls-'));
  const keyPath = resolve(directory, 'localhost-key.pem');
  const caPath = resolve(directory, 'localhost-ca.pem');
  const configPath = resolve(directory, 'openssl.cnf');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(
      configPath,
      `[req]
prompt = no
distinguished_name = localhost
x509_extensions = localhost_tls

[localhost]
CN = localhost

[localhost_tls]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`,
      { mode: 0o600 }
    );
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-config',
        configPath,
        '-keyout',
        keyPath,
        '-out',
        caPath
      ],
      { cwd: directory, timeout: 10000 }
    );
    await chmod(keyPath, 0o600);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(caPath)]);
    return { key, cert, caPath, directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
