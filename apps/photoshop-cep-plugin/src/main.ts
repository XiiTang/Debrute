import { startPhotoshopBridgePlugin } from '@debrute/photoshop-bridge-plugin-core';
import { createCepPhotoshopAdapter } from './cepPhotoshopAdapter.js';
import { createCepPhotoshopBridgeIdentityStore } from './identityStore.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Photoshop Bridge root element is required.');

startPhotoshopBridgePlugin({
  root,
  adapter: createCepPhotoshopAdapter(),
  identityStore: createCepPhotoshopBridgeIdentityStore(),
  clientRuntime: 'cep'
});
