import * as net from 'net';

const BLOCKED_DOMAINS = new Set([
  'www.facebook.com',
  'example.com',
]);

// Extract SNI from TLS ClientHello
function extractSNI(data: Buffer): string | null {
  let i = 0;

  if (data[i] !== 0x16) return null; // Not a TLS handshake
  i += 5; // Skip record header

  i += 38; // Skip fixed-length handshake header
  if (i >= data.length) return null;

  const sessionIDLength = data[i];
  i += 1 + sessionIDLength;

  if (i + 2 > data.length) return null;
  const cipherSuiteLength = data.readUInt16BE(i);
  i += 2 + cipherSuiteLength;

  const compressionMethodLength = data[i];
  i += 1 + compressionMethodLength;

  if (i + 2 > data.length) return null;
  const extensionsLength = data.readUInt16BE(i);
  i += 2;

  let end = i + extensionsLength;
  while (i + 4 <= end && i + 4 <= data.length) {
    const extType = data.readUInt16BE(i);
    const extLen = data.readUInt16BE(i + 2);
    i += 4;

    if (extType === 0x00 && i + extLen <= data.length) {
      // SNI extension
      const sniListLen = data.readUInt16BE(i + 2);
      const sniType = data[i + 4];
      const sniLen = data.readUInt16BE(i + 5);
      const sni = data.slice(i + 7, i + 7 + sniLen).toString('utf8');
      return sni;
    }
    i += extLen;
  }

  return null;
}

const server = net.createServer((clientSocket) => {
  clientSocket.once('data', (data) => {
    const sni = extractSNI(data);

    if (sni && BLOCKED_DOMAINS.has(sni)) {
      console.log(`Blocked: ${sni}`);
      clientSocket.end(); // Drop connection
      return;
    }

    // Forward to destination (assume HTTPS on port 443)
    const remoteSocket = net.connect(443, sni || '', () => {
      remoteSocket.write(data);
      clientSocket.pipe(remoteSocket).pipe(clientSocket);
    });

    remoteSocket.on('error', (err) => {
      console.error('Remote socket error:', err);
      clientSocket.end();
    });
  });

  clientSocket.on('error', (err) => {
    console.error('Client socket error:', err);
  });
});

server.listen(8443, () => {
  console.log('HTTPS blocking proxy listening on port 8443');
});
