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
  return createCepHost({ cep: withDebruteBridgeScript(window.__adobe_cep__, window.location.href), fs: window.cep });
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

export function bridgeScriptPathFromLocation(locationHref: string): string {
  const url = new URL('jsx/debruteBridge.jsx', locationHref);
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
}

function withDebruteBridgeScript(cep: CepEvalApi, locationHref: string): CepEvalApi {
  let bridgeScriptLoad: Promise<void> | undefined;
  return {
    evalScript(script, callback) {
      bridgeScriptLoad ??= loadDebruteBridgeScript(cep, bridgeScriptPathFromLocation(locationHref));
      bridgeScriptLoad.then(
        () => cep.evalScript(script, callback),
        (error) => callback(JSON.stringify({ ok: false, message: errorMessage(error) }))
      );
    }
  };
}

async function loadDebruteBridgeScript(cep: CepEvalApi, scriptPath: string): Promise<void> {
  await evalRawScript(cep, `$.evalFile(new File(${JSON.stringify(scriptPath)})); 'ok';`);
}

function evalRawScript(cep: CepEvalApi, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cep.evalScript(script, (raw) => {
      if (raw === 'EvalScript error.') {
        reject(new Error('Photoshop rejected the Debrute bridge script.'));
        return;
      }
      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
