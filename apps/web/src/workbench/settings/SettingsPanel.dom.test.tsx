import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DebruteGlobalSettingsView, DebruteProductState } from '@debrute/app-protocol';
import type { SettingsResource } from '../../types';
import { I18nProvider } from '../i18n/index';
import { installDialogTestAdapter } from '../ui/Modal.test-support';
import {
  SettingsPanel,
  type SettingsPanelState
} from './SettingsPanel';
import { AudioModelSettings, ImageModelSettings } from './MediaModelSettingsPage';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { AppearanceSettingsPage } from './appearance/AppearanceSettingsPage';
import type { WorkbenchSettingsActions } from './useWorkbenchSettingsController';

describe('SettingsPanel shared UI composition', { tags: ['settings'] }, () => {
  it('groups Settings navigation into General, Models, Integrations, and System', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <SettingsPanel state={stateWithSettings()} actions={actions()} />
      </I18nProvider>
    );

    expect(html).toContain('class="settings-directory-group"');
    expect(html).toContain('class="settings-directory-group__label">Models</span>');
    expect(html).toContain('class="settings-directory-group__label">Integrations</span>');
    expect(html).toContain('class="settings-directory-group__label">System</span>');
    expect(html.indexOf('Image Models')).toBeLessThan(html.indexOf('Integrations</strong>'));
    expect(html.indexOf('Integrations</strong>')).toBeLessThan(html.indexOf('About &amp; Updates</strong>'));
    expect(html).not.toContain('Plugins</strong>');
    expect(html).not.toContain('Adobe Bridge');
  });

  it('waits for both Settings and Photoshop hydration before rendering Integrations', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel
              state={stateWithSettings({ photoshop: { status: 'loading' } })}
              actions={actions()}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        requireButton(container, 'Integrations').click();
      });
      expect(container.querySelector('.settings-page')?.textContent).toContain('Loading settings');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('Photoshop');

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel state={stateWithSettings()} actions={actions()} />
          </I18nProvider>
        );
      });
      expect(container.querySelector('.settings-page')?.textContent).toContain('Photoshop');
      expect(container.querySelector('.settings-page')?.textContent).toContain('Off');
    } finally {
      await unmount(root, container);
    }
  });

  it('renders exactly one selected Settings page title', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <SettingsPanel state={stateWithSettings()} actions={actions()} />
      </I18nProvider>
    );

    expect((html.match(/<h2/g) ?? []).length).toBe(1);
    expect(html).toContain('<h2>General</h2>');
  });

  it('renders media model settings through Settings-owned model-card patterns', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings
          settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('settings-model-card');
    expect(html).toContain('settings-model-card__header');
    expect(html).toContain('settings-model-card__fields');
    expect(html).toContain('settings-secret-field');
    expect(html).toContain('settings-api-key-summary');
    expect(html).toContain('aria-label="Delete API key"');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('Configured');
    expect(html).not.toContain('sk****************************aa');
  });

  it('renders a ready empty state when a media category has no models', () => {
    const imageHtml = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings settings={[]} actions={actions()} />
      </I18nProvider>
    );
    const audioHtml = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AudioModelSettings
          settings={[]}
          actions={actions()}
          kind="tts"
        />
      </I18nProvider>
    );

    expect(imageHtml).toContain('class="db-empty-state"');
    expect(imageHtml).toContain('No models are available for this category.');
    expect(audioHtml).toContain('class="db-empty-state"');
    expect(audioHtml).toContain('No models are available for this category.');
  });

  it('saves a single media model API key from the model card', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mutateGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }
      await act(async () => {
        setInputValue(keyInput, ' sk-new ');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(mutateGlobalSettings).toHaveBeenCalledWith({
        operation: 'save-model-setting',
        modelId: 'gpt-image-2',
        setting: {
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKey: ' sk-new '
        }
      });
    } finally {
      await unmount(root, container);
    }
  });

  it('deletes a configured single media model API key from its status pill', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mutateGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });

      const deleteButton = requireButton(container, 'Delete API key');
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mutateGlobalSettings).toHaveBeenCalledWith({
        operation: 'save-model-setting',
        modelId: 'gpt-image-2',
        setting: {
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKey: ''
        }
      });
    } finally {
      await unmount(root, container);
    }
  });

  it('reveals one configured API key transiently and clears it without saving', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const exactApiKey = '  密钥🔑  ';
    const revealModelApiKey = vi.fn(async () => exactApiKey);
    const mutateGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), revealModelApiKey, mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }
      expect(keyInput.value).toBe('');

      await act(async () => {
        requireButton(container, 'Show API key').click();
        await Promise.resolve();
      });
      expect(revealModelApiKey).toHaveBeenCalledWith('gpt-image-2');
      expect(keyInput.value).toBe(exactApiKey);

      await act(async () => {
        keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(mutateGlobalSettings).not.toHaveBeenCalled();

      await act(async () => {
        requireButton(container, 'Hide API key').click();
      });
      expect(keyInput.value).toBe('');
    } finally {
      await unmount(root, container);
    }
  });

  it('clears a successfully saved replacement API key before another blur', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const save = deferred<void>();
    const mutateGlobalSettings = vi.fn(() => save.promise);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });
      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }

      await act(async () => {
        setInputValue(keyInput, 'replacement-key');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
        keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(mutateGlobalSettings).toHaveBeenCalledTimes(1);

      await act(async () => {
        save.resolve(undefined);
        await save.promise;
      });
      expect(keyInput.value).toBe('');

      await act(async () => {
        keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(mutateGlobalSettings).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(root, container);
    }
  });

  it('invalidates a pending stored-key reveal when the user starts typing', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const reveal = deferred<string>();
    const revealModelApiKey = vi.fn(() => reveal.promise);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), revealModelApiKey }}
            />
          </I18nProvider>
        );
      });
      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }

      await act(async () => {
        requireButton(container, 'Show API key').click();
        await Promise.resolve();
      });
      await act(async () => {
        setInputValue(keyInput, 'new-draft');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        reveal.resolve('stored-secret');
        await reveal.promise;
      });
      expect(keyInput.value).toBe('new-draft');
      expect(requireButton(container, 'Show API key')).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        setInputValue(keyInput, '');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(keyInput.value).toBe('');
      expect(container.textContent).not.toContain('stored-secret');
    } finally {
      await unmount(root, container);
    }
  });

  it('discards a pending stored-key reveal when persisted settings reset the field', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const reveal = deferred<string>();
    const revealModelApiKey = vi.fn(() => reveal.promise);
    const configured = readyResourceValue(stateWithSettings().globalSettings).models.image;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={configured}
              actions={{ ...actions(), revealModelApiKey }}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        requireButton(container, 'Show API key').click();
        await Promise.resolve();
      });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={configured.map((model) => ({ ...model, apiKeySet: false }))}
              actions={{ ...actions(), revealModelApiKey }}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        reveal.resolve('stored-secret');
        await reveal.promise;
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      expect(keyInput).toBeInstanceOf(HTMLInputElement);
      expect((keyInput as HTMLInputElement).value).toBe('');
      expect(container.textContent).not.toContain('stored-secret');
    } finally {
      await unmount(root, container);
    }
  });

  it('discards a pending stored-key reveal when the settings component unmounts', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const reveal = deferred<string>();
    const revealModelApiKey = vi.fn(() => reveal.promise);
    const mutateGlobalSettings = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <ImageModelSettings
            settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
            actions={{ ...actions(), revealModelApiKey, mutateGlobalSettings }}
          />
        </I18nProvider>
      );
    });
    await act(async () => {
      requireButton(container, 'Show API key').click();
      await Promise.resolve();
    });
    await unmount(root, container);
    await act(async () => {
      reveal.resolve('stored-secret');
      await reveal.promise;
    });

    expect(container.textContent).toBe('');
    expect(mutateGlobalSettings).not.toHaveBeenCalled();
  });

  it('preserves in-progress media model drafts when unchanged settings arrive as new objects', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mutateGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }
      await act(async () => {
        setInputValue(keyInput, 'sk-draft');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings({
                globalSettings: {
                  status: 'ready',
                  value: globalSettingsFixture({
                    chrome: { recentProjectRoots: ['/projects/alpha'] }
                  })
                }
              }).globalSettings).models.image}
              actions={{ ...actions(), mutateGlobalSettings }}
            />
          </I18nProvider>
        );
      });

      const nextKeyInput = container.querySelector('input[aria-label="API Key"]');
      expect(nextKeyInput).toBeInstanceOf(HTMLInputElement);
      expect((nextKeyInput as HTMLInputElement).value).toBe('sk-draft');
      expect(mutateGlobalSettings).not.toHaveBeenCalled();
    } finally {
      await unmount(root, container);
    }
  });

  it('omits missing API key status text from model cards', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <ImageModelSettings
          settings={readyResourceValue(stateWithSettings({
            globalSettings: {
              status: 'ready',
              value: globalSettingsFixture({
                models: {
                  ...globalSettingsFixture().models,
                  image: [{
                    debruteModelId: 'gpt-image-2',
                    summary: 'OpenAI gpt-image-2 image generation and edits.',
                    defaultBaseUrl: 'https://api.openai.com/v1',
                    defaultRequestModelId: 'gpt-image-2',
                    baseUrlOverride: null,
                    requestModelIdOverride: null,
                    apiKeySet: false
                  }]
                }
              })
            }
          }).globalSettings).models.image}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('settings-model-card');
    expect(html).toContain('API 密钥');
    expect(html).not.toContain('aria-label="Delete API key"');
  });

  it('keeps ordinary General settings separate from About and Updates', () => {
    const general = renderToStaticMarkup(
      <I18nProvider locale="en">
        <GeneralSettingsPage
          actions={actions()}
          product={{ status: 'ready', value: productState() }}
          settings={readyResourceValue(stateWithSettings().globalSettings)}
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );

    const about = renderToStaticMarkup(
      <I18nProvider locale="en">
        <GeneralSettingsPage
          actions={actions()}
          product={{ status: 'ready', value: productState() }}
          settings={readyResourceValue(stateWithSettings().globalSettings)}
          section="about"
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );
    expect((general.match(/class="settings-group"/g) ?? []).length).toBe(1);
    expect((about.match(/class="settings-group"/g) ?? []).length).toBe(2);
    expect(general).toContain('Start at Login');
    expect(general).toContain('Start Debrute Runtime when you log in. Workbench stays closed.');
    expect(general).not.toContain('<h3>Startup</h3>');
  });

  it('keeps Start at Login accepted-only until the Runtime projection confirms it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const save = deferred<void>();
    const onSettingsChange = vi.fn(() => save.promise);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              product={{ status: 'ready', value: productState() }}
              settings={globalSettingsFixture()}
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });

      const startAtLogin = requireSwitchForLabel(container, 'Start at Login');
      await act(async () => {
        startAtLogin.click();
        await Promise.resolve();
      });
      expect(onSettingsChange).toHaveBeenCalledWith({
        operation: 'set-start-at-login',
        enabled: true
      });
      expect(startAtLogin.disabled).toBe(true);
      expect(startAtLogin.checked).toBe(false);

      await act(async () => {
        save.resolve();
        await save.promise;
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              product={{ status: 'ready', value: productState() }}
              settings={globalSettingsFixture({ runtime: { startAtLogin: true } })}
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });
      expect(requireSwitchForLabel(container, 'Start at Login').checked).toBe(true);
    } finally {
      await unmount(root, container);
    }
  });

  it('shows the exact native Start at Login failure without changing the confirmed switch', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              product={{ status: 'ready', value: productState() }}
              settings={globalSettingsFixture()}
              onSettingsChange={vi.fn(async () => {
                throw new Error('native write denied');
              })}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireSwitchForLabel(container, 'Start at Login').click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain(
        'Failed to update Start at Login: native write denied'
      );
      expect(requireSwitchForLabel(container, 'Start at Login').checked).toBe(false);
    } finally {
      await unmount(root, container);
    }
  });

  it('renders Workbench Theme and the closed five-font catalog on Appearance', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AppearanceSettingsPage
          settings={globalSettingsFixture()}
          resolvedTheme="dark"
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Workbench Theme');
    expect(html).toContain('Canvas Text Appearance');
    for (const name of [
      'Noto Sans Mono CJK SC',
      'Lilex',
      'JetBrains Mono',
      'IBM Plex Mono',
      'Noto Sans SC'
    ]) {
      expect(html).toContain(name);
    }
    expect(html).not.toContain('Apply');
    expect(html).not.toContain('Restore default');
  });

  it('saves every valid Appearance change as one complete value without accepting invalid drafts', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSettingsChange = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <AppearanceSettingsPage
              settings={globalSettingsFixture()}
              resolvedTheme="dark"
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });

      await changeSelect(requireSelectWithOption(container, 'JetBrains Mono'), 'lilex');
      expect(onSettingsChange).toHaveBeenLastCalledWith({
        operation: 'set-canvas-text-appearance',
        textAppearance: {
          ...globalSettingsFixture().canvas.textAppearance,
          fontId: 'lilex'
        }
      });

      const weight = requireInputForLabel(container, 'Font weight');
      await act(async () => {
        setInputValue(weight, '600');
        weight.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onSettingsChange).toHaveBeenLastCalledWith({
        operation: 'set-canvas-text-appearance',
        textAppearance: {
          ...globalSettingsFixture().canvas.textAppearance,
          fontId: 'lilex',
          fontWeight: 600
        }
      });

      await act(async () => {
        weight.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          altKey: true,
          bubbles: true
        }));
      });
      expect(onSettingsChange).toHaveBeenLastCalledWith({
        operation: 'set-canvas-text-appearance',
        textAppearance: {
          ...globalSettingsFixture().canvas.textAppearance,
          fontId: 'lilex',
          fontWeight: 610
        }
      });

      const callCount = onSettingsChange.mock.calls.length;
      const fontSize = requireInputForLabel(container, 'Font size');
      await act(async () => {
        setInputValue(fontSize, '12.25');
        fontSize.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onSettingsChange).toHaveBeenCalledTimes(callCount);
      expect(fontSize.getAttribute('aria-invalid')).toBe('true');
    } finally {
      await unmount(root, container);
    }
  });

  it('uses neutral tones for quiet ready states', () => {
    const general = renderToStaticMarkup(
      <I18nProvider locale="en">
        <GeneralSettingsPage
          actions={actions()}
          product={{ status: 'ready', value: productState() }}
          settings={readyResourceValue(stateWithSettings().globalSettings)}
          section="about"
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );

    expect(general).toContain('db-status-pill--neutral');
  });

  it('installs an available Product update from Install and Restart', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const applyProductUpdate = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={{
                checkProductUpdate: vi.fn(async () => undefined),
                applyProductUpdate,
                removeProduct: vi.fn(async () => undefined)
              }}
              product={{ status: 'ready', value: availableProductState() }}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              section="about"
              onSettingsChange={async () => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireButton(container, 'Install and Restart').click();
        await Promise.resolve();
      });

      expect(applyProductUpdate).toHaveBeenCalledOnce();
    } finally {
      await unmount(root, container);
    }
  });

  it('shows the exact Product apply failure and allows one explicit retry', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const applyProductUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('checksum failed exactly'))
      .mockResolvedValueOnce(undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={{
                checkProductUpdate: vi.fn(async () => undefined),
                applyProductUpdate,
                removeProduct: vi.fn(async () => undefined)
              }}
              product={{ status: 'ready', value: availableProductState() }}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              section="about"
              onSettingsChange={async () => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireButton(container, 'Install and Restart').click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('checksum failed exactly');

      await act(async () => {
        requireButton(container, 'Install and Restart').click();
        await Promise.resolve();
      });
      expect(applyProductUpdate).toHaveBeenCalledTimes(2);
    } finally {
      await unmount(root, container);
    }
  });

  it('uses one Product removal confirmation and keeps API keys only when explicitly selected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const removeProduct = vi.fn(async (_keepConfig: boolean) => undefined);
    const restoreDialog = installDialogTestAdapter();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={{
                checkProductUpdate: vi.fn(async () => undefined),
                applyProductUpdate: vi.fn(async () => undefined),
                removeProduct
              }}
              product={{ status: 'ready', value: productState() }}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              onSettingsChange={async () => undefined}
            />
          </I18nProvider>
        );
      });

      const openRemoval = requireButton(container, 'Remove Debrute');
      openRemoval.focus();
      await act(async () => openRemoval.click());
      let dialog = document.querySelector<HTMLDialogElement>('[aria-labelledby="settings-removal-title"]');
      expect(dialog?.open).toBe(true);
      expect(container.inert).toBe(true);
      expect(document.activeElement?.textContent).toContain('Cancel');
      await act(async () => {
        dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
      });
      expect(document.querySelector('[aria-labelledby="settings-removal-title"]')).toBeNull();
      expect(container.inert).toBe(false);
      expect(document.activeElement).toBe(openRemoval);

      await act(async () => openRemoval.click());
      dialog = document.querySelector<HTMLDialogElement>('[aria-labelledby="settings-removal-title"]');
      expect(dialog?.textContent).toContain('Desktop, Runtime, CLI, official Skills, and local state');
      expect(dialog?.textContent).toContain('Projects are not removed');
      const keepConfig = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(keepConfig?.checked).toBe(false);
      await act(async () => keepConfig?.click());
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Remove Debrute');
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
      });

      expect(removeProduct).toHaveBeenCalledOnce();
      expect(removeProduct).toHaveBeenCalledWith(true);
    } finally {
      await unmount(root, container);
      restoreDialog();
    }
  });

  it('renders Workbench language and Product removal in General settings', () => {
    const saved: unknown[] = [];
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <GeneralSettingsPage
          actions={actions()}
          product={{ status: 'ready', value: productState() }}
          settings={{
            runtime: { startAtLogin: false },
            workbench: { locale: 'zh-CN', themePreference: 'system' },
            canvas: {
              hierarchyEdgesVisible: true,
              textAppearance: globalSettingsFixture().canvas.textAppearance
            },
            chrome: { recentProjectRoots: [] },
            integrations: { photoshop: { enabled: false } },
            feedback: { catalog: [], actionBar: [] },
            models: { image: [], video: [], audio: [] }
          }}
          onSettingsChange={async (settings) => {
            saved.push(settings);
          }}
        />
      </I18nProvider>
    );

    expect(html).not.toContain('<h2');
    expect(html).toContain('语言');
    expect(html).toContain('简体中文');
    expect(html).toContain('登录时启动');
    expect(html).toContain('登录系统时启动 Debrute Runtime，不打开 Workbench。');
    expect(html).not.toContain('应用');
    expect(html).toContain('移除 Debrute');
    expect(saved).toEqual([]);
  });

  it('preserves a rejected General language draft and shows its error', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSettingsChange = vi.fn(async () => {
      throw new Error('language unavailable');
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              product={{ status: 'ready', value: productState() }}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });

      const language = requireSelectWithOption(container, 'Simplified Chinese');
      await changeSelect(language, 'zh-CN');

      expect(language.value).toBe('zh-CN');

      const languageSection = requireSettingsSection(container, 'Language');
      expect(languageSection.textContent).toContain('Failed to save language preference: language unavailable');
    } finally {
      await unmount(root, container);
    }
  });

  it('synchronizes the General language draft when its persisted value changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      const renderSettings = async (settings: DebruteGlobalSettingsView) => {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <GeneralSettingsPage
                actions={actions()}
                product={{ status: 'ready', value: productState() }}
                settings={settings}
                onSettingsChange={async () => undefined}
              />
            </I18nProvider>
          );
        });
      };
      await renderSettings(globalSettingsFixture());
      await renderSettings(globalSettingsFixture({
        workbench: { locale: 'zh-CN', themePreference: 'light' }
      }));

      expect(requireSelectWithOption(container, 'Simplified Chinese').value).toBe('zh-CN');
    } finally {
      await unmount(root, container);
    }
  });

  it('renders one audio model kind per settings page', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AudioModelSettings
          settings={readyResourceValue(stateWithSettings().globalSettings).models.audio}
          actions={actions()}
          kind="tts"
        />
      </I18nProvider>
    );

    expect(html).toContain('openai-tts-1');
    expect(html).not.toContain('elevenlabs-music');
    expect(html).not.toContain('elevenlabs-sound-effects');
  });

  it('opens image, video, TTS, music, and SFX model settings as separate pages', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel state={stateWithSettings()} actions={actions()} />
          </I18nProvider>
        );
      });

      const imageModelsButton = requireButton(container, 'Image Models');
      const videoModelsButton = requireButton(container, 'Video Models');
      const ttsModelsButton = requireButton(container, 'TTS Models');
      const musicModelsButton = requireButton(container, 'Music Models');
      const sfxModelsButton = requireButton(container, 'SFX Models');

      await act(async () => {
        imageModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).toContain('gpt-image-2');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('doubao-seedance-2-0-260128');

      await act(async () => {
        videoModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('gpt-image-2');
      expect(container.querySelector('.settings-page')?.textContent).toContain('doubao-seedance-2-0-260128');

      await act(async () => {
        ttsModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('gpt-image-2');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('doubao-seedance-2-0-260128');
      expect(container.querySelector('.settings-page')?.textContent).toContain('openai-tts-1');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('elevenlabs-music');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('elevenlabs-sound-effects');

      await act(async () => {
        musicModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('openai-tts-1');
      expect(container.querySelector('.settings-page')?.textContent).toContain('elevenlabs-music');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('elevenlabs-sound-effects');

      await act(async () => {
        sfxModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('openai-tts-1');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('elevenlabs-music');
      expect(container.querySelector('.settings-page')?.textContent).toContain('elevenlabs-sound-effects');
    } finally {
      await unmount(root, container);
    }
  });

});

function stateWithSettings(overrides: Partial<SettingsPanelState> = {}): SettingsPanelState {
  return {
    globalSettings: { status: 'ready', value: globalSettingsFixture() },
    photoshop: { status: 'ready', value: { status: 'off', transferActive: false, sessions: [] } },
    product: { status: 'ready', value: productState() },
    resolvedTheme: 'dark',
    ...overrides
  };
}

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    runtime: { startAtLogin: false },
    workbench: { locale: 'en', themePreference: 'system' },
    canvas: {
      hierarchyEdgesVisible: true,
      textAppearance: {
        fontId: 'noto-sans-mono-cjk-sc',
        fontSizePx: 12,
        lineHeightRatio: 1.4,
        fontWeight: 400,
        letterSpacingPx: 0,
        ligatures: true
      }
    },
    chrome: { recentProjectRoots: [] },
    integrations: { photoshop: { enabled: false } },
    models: {
      image: [{
        debruteModelId: 'gpt-image-2',
        summary: 'OpenAI gpt-image-2 image generation and edits.',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-2',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true
      }],
      video: [{
        debruteModelId: 'doubao-seedance-2-0-260128',
        summary: 'Doubao Seedance 2.0 video generation.',
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultRequestModelId: 'doubao-seedance-2-0-260128',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: false
      }],
      audio: [{
        debruteModelId: 'openai-tts-1',
        kind: 'tts',
        summary: 'OpenAI tts-1 TTS generation.',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'tts-1',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: false
      }, {
        debruteModelId: 'elevenlabs-music',
        kind: 'music',
        summary: 'ElevenLabs music generation.',
        defaultBaseUrl: 'https://api.elevenlabs.io/v1',
        defaultRequestModelId: 'music_v2',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: false
      }, {
        debruteModelId: 'elevenlabs-sound-effects',
        kind: 'sound-effect',
        summary: 'ElevenLabs sound effects generation.',
        defaultBaseUrl: 'https://api.elevenlabs.io/v1',
        defaultRequestModelId: 'eleven_text_to_sound_v2',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: false
      }]
    },
    ...overrides,
    feedback: overrides.feedback ?? { catalog: [], actionBar: [] }
  };
}

function actions(): WorkbenchSettingsActions {
  return {
    checkProductUpdate: vi.fn(async () => undefined),
    applyProductUpdate: vi.fn(async () => undefined),
    mutateGlobalSettings: vi.fn(async () => undefined),
    removeProduct: vi.fn(async () => undefined),
    revealModelApiKey: vi.fn(async () => '')
  };
}

function readyResourceValue<T>(resource: SettingsResource<T>): T {
  if (resource.status !== 'ready') {
    throw new Error(`Expected ready resource, got ${resource.status}.`);
  }
  return resource.value;
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((candidate) => (
    candidate.textContent === label
    || candidate.getAttribute('aria-label') === label
    || candidate.getAttribute('title') === label
  ));
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = findButton(container, label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}.`);
  }
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLInputElement value setter.');
  }
  setter.call(input, value);
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLSelectElement value setter.');
  }
  setter.call(select, value);
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    setSelectValue(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireSelectWithOption(container: HTMLElement, option: string): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select')).find((candidate) => (
    candidate.textContent?.includes(option)
  ));
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Expected select containing option ${option}.`);
  }
  return select;
}

function requireInputForLabel(container: HTMLElement, label: string): HTMLInputElement {
  const field = Array.from(container.querySelectorAll<HTMLElement>('.db-field')).find((candidate) => (
    candidate.querySelector('.db-field__label')?.textContent === label
  ));
  const input = field?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected input for ${label}.`);
  }
  return input;
}

function requireSwitchForLabel(container: HTMLElement, label: string): HTMLInputElement {
  const switchLabel = Array.from(container.querySelectorAll<HTMLElement>('.db-switch')).find((candidate) => (
    candidate.querySelector('.db-switch__label')?.textContent === label
  ));
  const input = switchLabel?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected switch for ${label}.`);
  }
  return input;
}

function requireSettingsSection(container: HTMLElement, title: string): HTMLElement {
  const section = Array.from(container.querySelectorAll<HTMLElement>('.settings-group')).find((candidate) => (
    candidate.querySelector('h3')?.textContent === title
  ));
  if (!section) {
    throw new Error(`Expected Settings section ${title}.`);
  }
  return section;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}


function productState(): DebruteProductState {
  return {
    productVersion: '0.2.0',
    platform: 'darwin',
    cli: {
      status: 'ready',
      version: '0.2.0',
      path: '/Users/me/.debrute/bin/debrute',
      skillsVersion: '0.2.0',
      skillsRoot: '/Users/me/.agents/skills'
    },
    update: {
      type: 'up_to_date',
      currentVersion: '0.2.0'
    }
  };
}

function availableProductState(): DebruteProductState {
  return {
    ...productState(),
    update: {
      type: 'available',
      currentVersion: '0.2.0',
      updateVersion: '0.3.0',
      releaseName: 'Debrute 0.3.0'
    }
  };
}
