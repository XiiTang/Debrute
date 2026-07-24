import { startPhotoshopBridgePlugin } from '@debrute/photoshop-bridge-plugin-core';
import { createUxpPhotoshopBridgeIdentityStore } from './identityStore';
import { createPhotoshopAdapter } from './photoshopAdapter';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Photoshop Bridge root element is required.');

startPhotoshopBridgePlugin({
  root,
  adapter: createPhotoshopAdapter(),
  identityStore: createUxpPhotoshopBridgeIdentityStore(),
  clientRuntime: 'uxp'
});
