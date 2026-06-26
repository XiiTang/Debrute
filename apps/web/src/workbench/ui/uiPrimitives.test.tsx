import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Card,
  CloseButton,
  CommentPillInput,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  SecretInput,
  Select,
  StatusPill,
  Switch,
  Tab,
  TabList,
  Textarea,
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

  it('renders Workbench close buttons through one shared primitive', () => {
    const html = renderToStaticMarkup(
      <CloseButton label="Close example" className="example-close-button" />
    );

    expect(html).toContain('aria-label="Close example"');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('example-close-button');
    expect(html).toContain('width="10"');
    expect(html).toContain('height="10"');
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

  it('renders final primitive states through shared classes and ARIA state', () => {
    const html = renderToStaticMarkup(
      <Card variant="interactive">
        <Toolbar ariaLabel="Primitive states">
          <Button loading>Saving</Button>
          <Button pressed>Pressed</Button>
          <IconButton label="Toggle panel" pressed icon={<span data-icon="panel" />} />
        </Toolbar>
        <Field label="Endpoint" description="Base URL" error="Invalid URL">
          <Input invalid value="https://example.invalid" readOnly />
        </Field>
        <SecretInput masked value="secret" readOnly />
        <Select invalid defaultValue="a">
          <option value="a">A</option>
        </Select>
        <Textarea invalid value="body" readOnly />
        <Switch label="Enabled" checked readOnly />
        <TabList aria-label="Example tabs">
          <Tab active>Active</Tab>
          <Tab disabled>Disabled</Tab>
        </TabList>
        <StatusPill tone="warning">warning</StatusPill>
        <EmptyState title="No records" />
      </Card>
    );

    expect(html).toContain('db-card--interactive');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('db-input--invalid');
    expect(html).toContain('db-input--secret');
    expect(html).toContain('db-select--invalid');
    expect(html).toContain('db-textarea--invalid');
    expect(html).toContain('db-switch');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('db-status-pill--warning');
    expect(html).toContain('db-empty-state');
  });

  it('renders the reusable comment pill input with adaptive sizing only', () => {
    const html = renderToStaticMarkup(
      <CommentPillInput
        aria-label="File feedback comment"
        value="File comment"
        readOnly
        sizing={{ minWidthPx: 112, maxWidthPx: 260 }}
      />
    );

    expect(html).toContain('db-comment-pill-input');
    expect(html).toContain('aria-label="File feedback comment"');
    expect(html).toContain('--db-comment-pill-min-width:112px');
    expect(html).toContain('--db-comment-pill-max-width:260px');
    expect(html).toContain('--db-comment-pill-input-ch:');
    expect(html).not.toContain('db-comment-pill-input__badge');
    expect(html).not.toContain('db-comment-pill-input__close');
    expect(html).not.toContain('db-comment-pill-input--badge-until-hover');
  });
});
