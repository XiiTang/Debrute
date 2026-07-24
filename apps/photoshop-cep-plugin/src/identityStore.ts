import type { PhotoshopBridgeIdentityStore } from '@debrute/photoshop-bridge-plugin-core';

const IDENTITY_FILE = 'debrute-photoshop-bridge-identity-v1.json';
const IDENTITY_DIRECTORY = 'com.debrute.photoshop.bridge';

export function createCepPhotoshopBridgeIdentityStore(): PhotoshopBridgeIdentityStore {
  const cep = window.__adobe_cep__;
  const file = window.cep;
  if (!cep || !file) {
    throw new Error('CEP user-data storage is unavailable.');
  }
  const separator = cep.getSystemPath('userData').includes('\\') ? '\\' : '/';
  const directory = `${cep.getSystemPath('userData').replace(/[\\/]$/, '')}${separator}${IDENTITY_DIRECTORY}`;
  const path = `${directory}${separator}${IDENTITY_FILE}`;
  return {
    async read() {
      const result = file.fs.readFile(path, file.encoding.UTF8);
      return result.err === file.fs.NO_ERROR ? result.data : undefined;
    },
    async write(value) {
      file.fs.makedir(directory);
      const result = file.fs.writeFile(path, value, file.encoding.UTF8);
      if (result.err !== file.fs.NO_ERROR) {
        throw new Error('CEP could not persist the Photoshop Bridge identity.');
      }
    }
  };
}
