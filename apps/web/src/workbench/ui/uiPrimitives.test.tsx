import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Card,
  CloseButton,
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
  Toolbar
} from './index';
import { getNextMenuItemIndex } from './Menu';
import { getNextTabIndex } from './Tabs';

describe('Workbench UI primitives', () => {
  it('renders shared button variants and accessible icon buttons', () => {
    const html = renderToStaticMarkup(
      <Toolbar ariaLabel="Example actions">
        <Button variant="primary" size="sm" iconStart={<span data-icon="save" />}>Save</Button>
        <Button size="sm">Cancel</Button>
        <IconButton label="Close panel" icon={<span data-icon="close" />} />
      </Toolbar>
    );

    expect(html).toContain('db-toolbar');
    expect(html).toContain('db-button--primary');
    expect(html).toContain('db-button--default');
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
  });

  it('renders fields, cards, menus, pills, and empty states through shared classes', () => {
    const html = renderToStaticMarkup(
      <Card>
        <Field label="API Key" description="Used by model requests" error="Required">
          <Input value="sk-test" readOnly />
        </Field>
        <Menu ariaLabel="Card actions">
          <Menu.Item>Open</Menu.Item>
          <Menu.Separator />
          <Menu.Item variant="danger" disabled>Delete</Menu.Item>
        </Menu>
        <StatusPill tone="warning">update available</StatusPill>
        <EmptyState title="No files" description="Create a file to begin." />
      </Card>
    );

    expect(html).toContain('db-card');
    expect(html).toContain('db-field');
    expect(html).toContain('db-input');
    expect(html).toContain('db-menu');
    expect(html).toContain('role="separator"');
    expect(html).toContain('db-status-pill--warning');
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

  it('renders menu start and end content only when supplied', () => {
    const html = renderToStaticMarkup(
      <Menu ariaLabel="Layout actions">
        <Menu.Item>Plain</Menu.Item>
        <Menu.Item
          start={<span data-testid="menu-start" />}
          end={<span data-testid="menu-end">Ctrl+O</span>}
        >
          Open
        </Menu.Item>
      </Menu>
    );

    expect(html.match(/db-menu__item-start/g)).toHaveLength(1);
    expect(html.match(/db-menu__item-end/g)).toHaveLength(1);
    expect(html).toContain('data-testid="menu-start"');
    expect(html).toContain('data-testid="menu-end"');
    expect(html).not.toContain('db-menu__item-icon');
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

  it('renders pressed IconButton state through aria-pressed', () => {
    const html = renderToStaticMarkup(
      <IconButton label="Mini Map" pressed icon={<span />} />
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('db-icon-button--ghost');
  });

  it('renders Workbench tabs and chrome icon buttons through shared primitives', () => {
    const html = renderToStaticMarkup(
      <TabList aria-label="Panel tabs">
        <Tab active>Terminal</Tab>
        <IconButton variant="chrome" size="sm" label="New Terminal" icon={<span />} />
      </TabList>
    );

    expect(html).toContain('db-tab--strip');
    expect(html).toContain('db-icon-button--chrome');
    expect(html).toContain('db-icon-button--sm');
  });

  it('renders final primitive states through shared classes and ARIA state', () => {
    const html = renderToStaticMarkup(
      <Card>
        <Toolbar ariaLabel="Primitive states">
          <Button loading>Saving</Button>
          <IconButton label="Toggle panel" pressed icon={<span data-icon="panel" />} />
        </Toolbar>
        <Field label="Endpoint" description="Base URL" error="Invalid URL">
          <Input invalid value="https://example.invalid" readOnly />
        </Field>
        <SecretInput masked value="secret" readOnly />
        <Select invalid defaultValue="a">
          <option value="a">A</option>
        </Select>
        <Switch label="Enabled" checked readOnly />
        <TabList aria-label="Example tabs">
          <Tab active>Active</Tab>
          <Tab disabled>Disabled</Tab>
        </TabList>
        <StatusPill tone="warning">warning</StatusPill>
        <EmptyState title="No records" />
      </Card>
    );

    expect(html).toContain('db-card');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('db-input--invalid');
    expect(html).toContain('db-input--secret');
    expect(html).toContain('db-select--invalid');
    expect(html).toContain('db-switch');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('db-status-pill--warning');
    expect(html).toContain('db-empty-state');
  });

});
