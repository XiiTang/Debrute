import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasCardBar } from './CanvasCardBar';

interface ButtonProps {
  role?: string;
  onClick(event?: { currentTarget: { closest(selector: string): { removeAttribute(name: string): void } | null } }): void;
  'aria-pressed'?: boolean;
  pressed?: boolean;
  hidden?: boolean;
  children?: React.ReactNode;
}

interface FormProps {
  className?: string;
  onSubmit(event: {
    preventDefault(): void;
    currentTarget: {
      elements: {
        namedItem(name: string): { value?: string } | null;
      };
      closest(selector: string): { removeAttribute(name: string): void } | null;
    };
  }): void;
  children?: React.ReactNode;
}

interface InputProps {
  name?: string;
  defaultValue?: string;
  'aria-label'?: string;
}

describe('CanvasCardBar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders canvas cards and switches active canvas on click', () => {
    const onActiveCanvasChange = vi.fn();
    const element = CanvasCardBar({
      canvasOrder: ['canvas-1', 'storyboard'],
      activeCanvasId: 'canvas-1',
      onActiveCanvasChange,
      onCreateCanvas: async () => undefined,
      onRenameCanvas: async () => undefined,
      onDeleteCanvas: async () => undefined,
      onReorderCanvases: async () => undefined
    });

    buttonByText(element, 'storyboard').props.onClick();

    expect(buttonByText(element, 'canvas-1').props.pressed ?? buttonByText(element, 'canvas-1').props['aria-pressed']).toBe(true);
    expect(onActiveCanvasChange).toHaveBeenCalledWith('storyboard');
    const html = renderToStaticMarkup(element);
    expect(html).toContain('db-button');
    expect(html).toContain('db-button--sm');
    expect(html).toContain('db-icon-button');
  });

  it('submits canvas menu actions without browser prompt or confirm dialogs', () => {
    const onCreateCanvas = vi.fn(async () => undefined);
    const onRenameCanvas = vi.fn(async () => undefined);
    const onDeleteCanvas = vi.fn(async () => undefined);
    const prompt = vi.fn(() => 'prompted');
    const confirm = vi.fn(() => true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);
    const element = CanvasCardBar({
      canvasOrder: ['canvas-1'],
      activeCanvasId: 'canvas-1',
      onActiveCanvasChange: () => undefined,
      onCreateCanvas,
      onRenameCanvas,
      onDeleteCanvas,
      onReorderCanvases: async () => undefined
    });

    menuItemByText(element, 'New Canvas').props.onClick(clickEvent());
    renameForm(element).props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {
        elements: {
          namedItem: () => ({ value: 'renamed' })
        },
        closest: () => ({ removeAttribute: vi.fn() })
      }
    });
    menuItemByText(element, 'Confirm Delete').props.onClick(clickEvent());

    expect(onCreateCanvas).toHaveBeenCalled();
    expect(onRenameCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1', nextCanvasId: 'renamed' });
    expect(onDeleteCanvas).toHaveBeenCalledWith({ canvasId: 'canvas-1' });
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('renders inline rename and explicit delete confirmation controls in the menu', () => {
    const element = CanvasCardBar({
      canvasOrder: ['canvas-1'],
      activeCanvasId: 'canvas-1',
      onActiveCanvasChange: () => undefined,
      onCreateCanvas: async () => undefined,
      onRenameCanvas: async () => undefined,
      onDeleteCanvas: async () => undefined,
      onReorderCanvases: async () => undefined
    });

    expect(renameInput(element).props).toMatchObject({
      name: 'nextCanvasId',
      defaultValue: 'canvas-1',
      'aria-label': 'Rename canvas-1'
    });
    expect(menuItemByText(element, 'Confirm Delete').props.hidden).toBe(true);
    expect(renderToStaticMarkup(element)).toContain('db-menu');
  });
});

function buttonByText(element: React.ReactElement, text: string): React.ReactElement<ButtonProps> {
  const button = elements(element).find((item) => (
    typeof item.props.onClick === 'function'
    && textContent(item) === text
  ));
  if (!button) {
    throw new Error(`Expected button: ${text}`);
  }
  return button as React.ReactElement<ButtonProps>;
}

function menuItemByText(element: React.ReactElement, text: string): React.ReactElement<ButtonProps> {
  const item = elements(element).find((candidate) => (
    typeof candidate.props.onClick === 'function'
    && textContent(candidate) === text
  ));
  if (!item) {
    throw new Error(`Expected menu item: ${text}`);
  }
  return item as React.ReactElement<ButtonProps>;
}

function renameForm(element: React.ReactElement): React.ReactElement<FormProps> {
  const form = elements(element).find((candidate) => (
    candidate.type === 'form'
    && candidate.props.className === 'canvas-card-rename-form'
  ));
  if (!form) {
    throw new Error('Expected rename form');
  }
  return form as React.ReactElement<FormProps>;
}

function renameInput(element: React.ReactElement): React.ReactElement<InputProps> {
  const input = elements(element).find((candidate) => (
    (candidate.props as InputProps).name === 'nextCanvasId'
  ));
  if (!input) {
    throw new Error('Expected rename input');
  }
  return input as React.ReactElement<InputProps>;
}

function clickEvent() {
  return {
    currentTarget: {
      closest: () => ({ removeAttribute: vi.fn() })
    }
  };
}

function elements(node: React.ReactNode): Array<React.ReactElement<{ children?: React.ReactNode; role?: unknown; className?: string; onClick?: unknown }>> {
  if (!React.isValidElement(node)) {
    return [];
  }
  const element = node as React.ReactElement<{ children?: React.ReactNode; role?: unknown; className?: string; onClick?: unknown }>;
  return [
    element,
    ...React.Children.toArray(element.props.children).flatMap(elements)
  ];
}

function textContent(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!React.isValidElement(node)) {
    return '';
  }
  return React.Children.toArray((node.props as { children?: React.ReactNode }).children).map(textContent).join('');
}
