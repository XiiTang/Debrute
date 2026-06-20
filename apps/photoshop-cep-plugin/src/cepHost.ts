export interface CepEvalApi {
  evalScript(script: string, callback: (result: string) => void): void;
}

export interface CepFileApi {
  encoding: { Base64: string; UTF8: string };
  fs: {
    NO_ERROR: number;
    readFile(path: string, encoding: string): { err: number; data: string };
    writeFile(path: string, data: string, encoding: string): { err: number };
    deleteFile(path: string): { err: number };
  };
}

export interface CepHost {
  evalJson<T>(script: string): Promise<T>;
  readFileBytes(path: string): Uint8Array;
  writeFileBytes(path: string, bytes: Uint8Array): void;
  deleteFile(path: string): void;
}

interface CepEnvelope<T> {
  ok: boolean;
  value?: T;
  message?: string;
}

export function createBrowserCepHost(): CepHost {
  if (!window.__adobe_cep__) {
    throw new Error('CEP runtime is unavailable.');
  }
  if (!window.cep) {
    throw new Error('CEP file runtime is unavailable.');
  }
  return createCepHost({ cep: window.__adobe_cep__, fs: window.cep });
}

export function createCepHost(input: {
  cep: CepEvalApi;
  fs: CepFileApi | undefined;
}): CepHost {
  return {
    evalJson(script) {
      return new Promise((resolve, reject) => {
        input.cep.evalScript(script, (raw) => {
          const envelope = JSON.parse(raw) as CepEnvelope<unknown>;
          if (!envelope.ok) {
            reject(new Error(envelope.message || 'Photoshop command failed.'));
            return;
          }
          resolve(envelope.value as never);
        });
      });
    },
    readFileBytes(path) {
      const fs = requiredFileApi(input.fs);
      const result = fs.fs.readFile(path, fs.encoding.Base64);
      if (result.err !== fs.fs.NO_ERROR) {
        throw new Error(`CEP failed to read file: ${path}`);
      }
      return base64ToUint8Array(result.data);
    },
    writeFileBytes(path, bytes) {
      const fs = requiredFileApi(input.fs);
      const result = fs.fs.writeFile(path, uint8ArrayToBase64(bytes), fs.encoding.Base64);
      if (result.err !== fs.fs.NO_ERROR) {
        throw new Error(`CEP failed to write file: ${path}`);
      }
    },
    deleteFile(path) {
      const fs = requiredFileApi(input.fs);
      const result = fs.fs.deleteFile(path);
      if (result.err !== fs.fs.NO_ERROR) {
        throw new Error(`CEP failed to delete file: ${path}`);
      }
    }
  };
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requiredFileApi(fs: CepFileApi | undefined): CepFileApi {
  if (!fs) {
    throw new Error('CEP file runtime is unavailable.');
  }
  return fs;
}
