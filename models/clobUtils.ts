import type { Lob } from 'oracledb';

function readClobAsString(clob: Lob | null): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (clob === null) return resolve(null);

    let data = '';

    clob.setEncoding('utf8');
    clob.on('data', (chunk: string) => (data += chunk));
    clob.on('end', () => resolve(data));
    clob.on('error', (err: Error) => reject(err));
  });
}

export { readClobAsString };
