import type { AdobeBridgeSettings, SaveAdobeBridgeSettingsInput } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';

export class AdobeBridgeSettingsService {
  constructor(private readonly input: { configStore: GlobalConfigStore }) {}

  async getSettings(): Promise<AdobeBridgeSettings> {
    const config = await this.input.configStore.readAdobeBridge();
    return adobeBridgeSettingsFromEnabled(config.enabled);
  }

  async saveSettings(input: SaveAdobeBridgeSettingsInput): Promise<AdobeBridgeSettings> {
    await this.input.configStore.saveAdobeBridge({ enabled: input.enabled });
    return adobeBridgeSettingsFromEnabled(input.enabled);
  }
}

function adobeBridgeSettingsFromEnabled(enabled: boolean): AdobeBridgeSettings {
  return {
    enabled,
    discoveryStatus: enabled ? 'unavailable' : 'disabled'
  };
}
