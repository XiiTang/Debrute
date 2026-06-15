import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  StatusPill,
  Toolbar
} from './index';
import { getNextMenuItemIndex } from './Menu';
import { getNextTabIndex } from './Tabs';

describe('Workbench UI primitives', () => {
  it('renders shared button variants and accessible icon buttons', () => {
    const html = renderToStaticMarkup(
      <Toolbar ariaLabel="Example actions">
        <Button variant="primary" size="sm" iconStart={<span data-icon="save" />}>Save</Button>
        <Button variant="danger" size="sm">Delete</Button>
        <IconButton label="Close panel" icon={<span data-icon="close" />} />
      </Toolbar>
    );

    expect(html).toContain('db-toolbar');
    expect(html).toContain('db-button--primary');
    expect(html).toContain('db-button--danger');
    expect(html).toContain('aria-label="Close panel"');
    expect(html).toContain('db-icon-button');
  });

  it('renders fields, cards, menus, pills, and empty states through shared classes', () => {
    const html = renderToStaticMarkup(
      <Card variant="selected">
        <Field label="API Key" description="Used by model requests" error="Required">
          <Input value="sk-test" readOnly />
        </Field>
        <Menu ariaLabel="Card actions">
          <Menu.Item>Open</Menu.Item>
          <Menu.Separator />
          <Menu.Item variant="danger" disabled>Delete</Menu.Item>
        </Menu>
        <StatusPill tone="success">configured</StatusPill>
        <EmptyState title="No files" description="Create a file to begin." />
      </Card>
    );

    expect(html).toContain('db-card--selected');
    expect(html).toContain('db-field');
    expect(html).toContain('db-input');
    expect(html).toContain('db-menu');
    expect(html).toContain('role="separator"');
    expect(html).toContain('db-status-pill--success');
    expect(html).toContain('db-empty-state');
    expect(html).toContain('aria-invalid="true"');
  });

  it('centralizes menu keyboard focus order and skips disabled entries', () => {
    expect(getNextMenuItemIndex({
      currentIndex: 0,
      direction: 'next',
      itemCount: 4,
      disabledIndexes: new Set([1])
    })).toBe(2);
    expect(getNextMenuItemIndex({
      currentIndex: 0,
      direction: 'previous',
      itemCount: 4,
      disabledIndexes: new Set([1])
    })).toBe(3);
    expect(getNextMenuItemIndex({
      currentIndex: 2,
      direction: 'first',
      itemCount: 4,
      disabledIndexes: new Set([0])
    })).toBe(1);
    expect(getNextMenuItemIndex({
      currentIndex: 2,
      direction: 'last',
      itemCount: 4,
      disabledIndexes: new Set([3])
    })).toBe(2);
  });

  it('centralizes tab keyboard focus order and skips disabled tabs', () => {
    expect(getNextTabIndex({
      currentIndex: 0,
      direction: 'next',
      tabCount: 3,
      disabledIndexes: new Set([1])
    })).toBe(2);
    expect(getNextTabIndex({
      currentIndex: 0,
      direction: 'previous',
      tabCount: 3,
      disabledIndexes: new Set([1])
    })).toBe(2);
  });

  it('renders pressed IconButton state through aria-pressed only', () => {
    const html = renderToStaticMarkup(
      <IconButton label="Mini Map" pressed icon={<span />} />
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('db-icon-button--ghost');
    expect(html).not.toContain(' active');
  });
});
