import {
  installPhotoshopEntrypoints,
  type PhotoshopEntrypoints
} from './PhotoshopEntrypoints.js';
import { PhotoshopPanelView } from './PhotoshopPanelView.js';
import { PhotoshopPluginRuntime } from './PhotoshopPluginRuntime.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Debrute Photoshop root element is required.');

const runtime = new PhotoshopPluginRuntime();
const view = new PhotoshopPanelView(root, runtime);
const { entrypoints } = uxpRequire<{ entrypoints: PhotoshopEntrypoints }>('uxp');
installPhotoshopEntrypoints({ entrypoints, runtime, view, root });

function uxpRequire<T>(id: string): T {
  return (globalThis as unknown as { require(moduleId: string): unknown }).require(id) as T;
}
