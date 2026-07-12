import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient } from '@debrute/app-protocol';
import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import { useTextFileBufferActions, type TextFileBufferActions } from './textFileBufferActions';

describe('useTextFileBufferActions', () => {
  it('preserves edits made while a save is pending', async () => {
    const projectRelativePath = '.debrute/project.json';
    const pendingWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(() => pendingWrite.promise);
    const probe = await renderActions({ writeProjectTextFile }, projectRelativePath);

    let save!: Promise<void>;
    await act(async () => {
      save = probe.current.actions.saveTextFileBuffer(projectRelativePath);
      await Promise.resolve();
    });
    await act(async () => {
      probe.current.actions.updateTextFileBuffer(projectRelativePath, '{"name":"Edited while saving"}');
    });

    expect(probe.current.buffers[projectRelativePath]).toMatchObject({
      content: '{"name":"Edited while saving"}',
      dirty: true,
      saving: true,
      baseRevision: 'disk-rev'
    });

    pendingWrite.resolve(projectTextFileWriteResult(projectRelativePath, '# Edited', 'saved-rev'));
    await act(async () => {
      await save;
    });

    expect(probe.current.buffers[projectRelativePath]).toMatchObject({
      content: '{"name":"Edited while saving"}',
      dirty: true,
      saving: false,
      baseRevision: 'saved-rev',
      externalChange: false
    });
    await probe.unmount();
  });

  it('serializes saves and writes only the latest explicitly queued content', async () => {
    const firstWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const secondWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const probe = await renderActions({ writeProjectTextFile });

    await act(async () => {
      void probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await act(async () => {
      probe.current.actions.updateTextFileBuffer('brief.md', '# Queued once');
    });
    let queuedSave!: Promise<void>;
    await act(async () => {
      queuedSave = probe.current.actions.saveTextFileBuffer('brief.md');
      probe.current.actions.updateTextFileBuffer('brief.md', '# Latest queued');
      void probe.current.actions.saveTextFileBuffer('brief.md');
    });

    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(1, {
      projectRelativePath: 'brief.md',
      content: '# Edited',
      expectedRevision: 'disk-rev'
    });

    firstWrite.resolve(projectTextFileWriteResult('brief.md', '# Edited', 'saved-rev-1'));
    await act(async () => {
      await vi.waitFor(() => expect(writeProjectTextFile).toHaveBeenCalledTimes(2));
    });
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(2, {
      projectRelativePath: 'brief.md',
      content: '# Latest queued',
      expectedRevision: 'saved-rev-1'
    });

    secondWrite.resolve(projectTextFileWriteResult('brief.md', '# Latest queued', 'saved-rev-2'));
    await act(async () => {
      await queuedSave;
    });

    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Latest queued',
      dirty: false,
      saving: false,
      baseRevision: 'saved-rev-2',
      externalChange: false
    });
    await probe.unmount();
  });

  it('shares the active write when the same content version is saved repeatedly', async () => {
    const pendingWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(() => pendingWrite.promise);
    const probe = await renderActions({ writeProjectTextFile });

    let firstSave!: Promise<void>;
    let repeatedSave!: Promise<void>;
    await act(async () => {
      firstSave = probe.current.actions.saveTextFileBuffer('brief.md');
      repeatedSave = probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });

    expect(writeProjectTextFile).toHaveBeenCalledOnce();

    pendingWrite.resolve(projectTextFileWriteResult('brief.md', '# Edited', 'saved-rev'));
    await act(async () => {
      await Promise.all([firstSave, repeatedSave]);
    });

    expect(writeProjectTextFile).toHaveBeenCalledOnce();
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Edited',
      dirty: false,
      saving: false,
      baseRevision: 'saved-rev'
    });
    await probe.unmount();
  });

  it('runs an explicitly queued newer save after the active write fails', async () => {
    const firstWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(projectTextFileWriteResult('brief.md', '# Newer content', 'saved-rev'));
    const probe = await renderActions({ writeProjectTextFile });

    await act(async () => {
      void probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await act(async () => {
      probe.current.actions.updateTextFileBuffer('brief.md', '# Newer content');
    });
    let queuedSave!: Promise<void>;
    await act(async () => {
      queuedSave = probe.current.actions.saveTextFileBuffer('brief.md');
    });

    firstWrite.reject(new Error('Temporary write failure'));
    await act(async () => {
      await queuedSave;
    });

    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(2, {
      projectRelativePath: 'brief.md',
      content: '# Newer content',
      expectedRevision: 'disk-rev'
    });
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Newer content',
      dirty: false,
      saving: false,
      baseRevision: 'saved-rev',
      externalChange: false
    });
    await probe.unmount();
  });

  it('reloads only after the active save chain finishes', async () => {
    const pendingWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(() => pendingWrite.promise);
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(async () => ({
      projectRelativePath: 'brief.md',
      content: '# Reloaded',
      revision: 'reloaded-rev',
      size: 10,
      mtimeMs: 2,
      language: 'markdown',
      mimeType: 'text/markdown'
    }));
    const probe = await renderActions({ readProjectTextFile, writeProjectTextFile });

    await act(async () => {
      void probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    let reload!: Promise<void>;
    await act(async () => {
      reload = probe.current.actions.reloadTextFileBuffer('brief.md');
      await Promise.resolve();
    });

    expect(readProjectTextFile).not.toHaveBeenCalled();

    pendingWrite.resolve(projectTextFileWriteResult('brief.md', '# Edited', 'saved-rev'));
    await act(async () => {
      await reload;
    });

    expect(readProjectTextFile).toHaveBeenCalledOnce();
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Reloaded',
      dirty: false,
      saving: false,
      baseRevision: 'reloaded-rev'
    });
    await probe.unmount();
  });

  it('isolates an active save from the same path in a newly opened project', async () => {
    const firstProjectWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const secondProjectWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>()
      .mockImplementationOnce(() => firstProjectWrite.promise)
      .mockImplementationOnce(() => secondProjectWrite.promise);
    const probe = await renderActions({ writeProjectTextFile });

    await act(async () => {
      void probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await probe.switchProject('project-2', textFileBufferFixture('brief.md', '# Project B', 'project-b-rev'));

    let secondProjectSave!: Promise<void>;
    await act(async () => {
      secondProjectSave = probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });

    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(2, {
      projectRelativePath: 'brief.md',
      content: '# Project B',
      expectedRevision: 'project-b-rev'
    });

    firstProjectWrite.resolve(projectTextFileWriteResult('brief.md', '# Edited', 'project-a-saved-rev'));
    secondProjectWrite.resolve(projectTextFileWriteResult('brief.md', '# Project B', 'project-b-saved-rev'));
    await act(async () => {
      await secondProjectSave;
    });

    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Project B',
      dirty: false,
      saving: false,
      baseRevision: 'project-b-saved-rev'
    });
    await probe.unmount();
  });

  it('does not clear a newer external revision observed before the save response', async () => {
    const pendingWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(() => pendingWrite.promise);
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(async () => ({
      projectRelativePath: 'brief.md',
      content: '# External after commit',
      revision: 'external-rev',
      size: 23,
      mtimeMs: 3,
      language: 'markdown',
      mimeType: 'text/markdown'
    }));
    const probe = await renderActions({ readProjectTextFile, writeProjectTextFile });

    let save!: Promise<void>;
    await act(async () => {
      save = probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await act(async () => {
      await probe.current.actions.refreshTextFileBuffer('brief.md');
    });
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Edited',
      dirty: true,
      saving: true,
      baseRevision: 'disk-rev',
      externalChange: true
    });

    pendingWrite.resolve(projectTextFileWriteResult('brief.md', '# Edited', 'saved-rev'));
    await act(async () => {
      await save;
    });

    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Edited',
      dirty: true,
      saving: false,
      baseRevision: 'disk-rev',
      externalChange: true
    });
    await probe.unmount();
  });

  it('does not run a queued save across an external revision after the active write fails', async () => {
    const pendingWrite = deferred<Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>>>();
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(() => pendingWrite.promise);
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(async () => (
      projectTextFile('brief.md', '# External edit', 'external-rev')
    ));
    const probe = await renderActions({ readProjectTextFile, writeProjectTextFile });

    await act(async () => {
      void probe.current.actions.saveTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await act(async () => {
      probe.current.actions.updateTextFileBuffer('brief.md', '# Queued local edit');
    });
    let queuedSave!: Promise<void>;
    await act(async () => {
      queuedSave = probe.current.actions.saveTextFileBuffer('brief.md');
      await probe.current.actions.refreshTextFileBuffer('brief.md');
    });

    pendingWrite.reject(new Error('Project text file revision is stale: brief.md'));
    await act(async () => {
      await queuedSave;
    });

    expect(writeProjectTextFile).toHaveBeenCalledOnce();
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Queued local edit',
      dirty: true,
      saving: false,
      baseRevision: 'disk-rev',
      externalChange: true,
      error: 'Project text file revision is stale: brief.md'
    });
    await probe.unmount();
  });

  it('ignores a reload result from the previously opened project', async () => {
    const pendingRead = deferred<Awaited<ReturnType<WorkbenchApiClient['readProjectTextFile']>>>();
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(() => pendingRead.promise);
    const probe = await renderActions({ readProjectTextFile });

    let reload!: Promise<void>;
    await act(async () => {
      reload = probe.current.actions.reloadTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await probe.switchProject('project-2', textFileBufferFixture('brief.md', '# Project B', 'project-b-rev'));

    pendingRead.resolve(projectTextFile('brief.md', '# Project A reload', 'project-a-rev'));
    await act(async () => {
      await reload;
    });

    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Project B',
      baseRevision: 'project-b-rev'
    });
    expect(probe.current.buffers['brief.md']?.error).toBeUndefined();
    await probe.unmount();
  });

  it('ignores an initial text read from the previously opened project', async () => {
    const pendingRead = deferred<Awaited<ReturnType<WorkbenchApiClient['readProjectTextFile']>>>();
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(() => pendingRead.promise);
    const probe = await renderActions({ readProjectTextFile });
    await act(async () => probe.current.replaceBuffers({}));

    let ensure!: Promise<void>;
    await act(async () => {
      ensure = probe.current.actions.ensureTextFileBuffer('brief.md');
      await Promise.resolve();
    });
    await probe.switchProject('project-2', textFileBufferFixture('brief.md', '# Project B', 'project-b-rev'));

    pendingRead.resolve(projectTextFile('brief.md', '# Project A', 'project-a-rev'));
    await act(async () => {
      await ensure;
    });

    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Project B',
      baseRevision: 'project-b-rev'
    });
    await probe.unmount();
  });

  it.each(['reload', 'refresh'] as const)(
    'ignores a failed %s read from the previously opened project',
    async (action) => {
      const pendingRead = deferred<Awaited<ReturnType<WorkbenchApiClient['readProjectTextFile']>>>();
      const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(() => pendingRead.promise);
      const probe = await renderActions({ readProjectTextFile });

      let read!: Promise<void>;
      await act(async () => {
        read = action === 'reload'
          ? probe.current.actions.reloadTextFileBuffer('brief.md')
          : probe.current.actions.refreshTextFileBuffer('brief.md');
        await Promise.resolve();
      });
      await probe.switchProject('project-2', textFileBufferFixture('brief.md', '# Project B', 'project-b-rev'));

      pendingRead.reject(new Error('Old project read failed'));
      await act(async () => {
        await read;
      });

      expect(probe.current.buffers['brief.md']).toMatchObject({
        content: '# Project B',
        baseRevision: 'project-b-rev'
      });
      expect(probe.current.buffers['brief.md']?.error).toBeUndefined();
      await probe.unmount();
    }
  );

  it('accepts a committed save and replaces the buffer revision without parsing the content', async () => {
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(async () => ({
      projectId: 'project-1',
      projectRevision: 2,
      file: {
        projectRelativePath: 'brief.md',
        content: '{}',
        revision: 'saved-rev',
        size: 2,
        mtimeMs: 1,
        language: 'markdown',
        mimeType: 'text/markdown'
      }
    }));
    const probe = await renderActions({ writeProjectTextFile });

    await act(async () => {
      await probe.current.actions.saveTextFileBuffer('brief.md');
    });

    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '{}',
      baseRevision: 'saved-rev',
      dirty: false,
      saving: false,
      externalChange: false
    });
    await probe.unmount();
  });

  it('saves with the buffer disk revision and keeps rejected content dirty', async () => {
    const readProjectTextFile = vi.fn<WorkbenchApiClient['readProjectTextFile']>(async () => ({
      projectRelativePath: 'brief.md',
      content: '# External edit',
      revision: 'external-rev',
      size: 15,
      mtimeMs: 2,
      language: 'markdown',
      mimeType: 'text/markdown'
    }));
    const writeProjectTextFile = vi.fn<WorkbenchApiClient['writeProjectTextFile']>(async () => {
      throw new Error('Project text file revision is stale: brief.md');
    });
    const probe = await renderActions({ readProjectTextFile, writeProjectTextFile });

    await act(async () => {
      await probe.current.actions.refreshTextFileBuffer('brief.md');
    });
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Edited',
      baseRevision: 'disk-rev',
      externalChange: true
    });

    await act(async () => {
      await probe.current.actions.saveTextFileBuffer('brief.md');
      await probe.current.actions.saveTextFileBuffer('brief.md');
    });

    expect(writeProjectTextFile).toHaveBeenNthCalledWith(1, {
      projectRelativePath: 'brief.md',
      content: '# Edited',
      expectedRevision: 'disk-rev'
    });
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(2, {
      projectRelativePath: 'brief.md',
      content: '# Edited',
      expectedRevision: 'disk-rev'
    });
    expect(probe.current.buffers['brief.md']).toMatchObject({
      content: '# Edited',
      dirty: true,
      saving: false,
      error: 'Project text file revision is stale: brief.md'
    });
    await probe.unmount();
  });
});

interface ActionsProbeValue {
  actions: TextFileBufferActions;
  buffers: Record<string, TextFileBuffer>;
  replaceBuffers(buffers: Record<string, TextFileBuffer>): void;
}

function ActionsProbe({ api, projectId, initialProjectRelativePath, onValue }: {
  api: Partial<WorkbenchApiClient>;
  projectId: string;
  initialProjectRelativePath: string;
  onValue(value: ActionsProbeValue): void;
}): null {
  const [buffers, setBuffers] = useState<Record<string, TextFileBuffer>>({
    [initialProjectRelativePath]: textFileBufferFixture(initialProjectRelativePath, '# Edited', 'disk-rev')
  });
  const buffersRef = useRef(buffers);
  const windowsRef = useRef<Record<string, FloatingTextEditorWindowState>>({});
  buffersRef.current = buffers;
  const actions = useTextFileBufferActions({
    api: api as WorkbenchApiClient,
    projectId,
    textFileBuffers: buffers,
    setTextFileBuffers: setBuffers,
    textFileBuffersRef: buffersRef,
    textEditorWindowsRef: windowsRef
  });
  useEffect(() => onValue({ actions, buffers, replaceBuffers: setBuffers }), [actions, buffers, onValue]);
  return null;
}

async function renderActions(api: Partial<WorkbenchApiClient>, initialProjectRelativePath = 'brief.md'): Promise<{
  readonly current: ActionsProbeValue;
  switchProject(projectId: string, buffer: TextFileBuffer): Promise<void>;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: ActionsProbeValue;
  const renderProject = async (projectId: string): Promise<void> => {
    await act(async () => root.render(
      <ActionsProbe
        api={api}
        projectId={projectId}
        initialProjectRelativePath={initialProjectRelativePath}
        onValue={(value) => { current = value; }}
      />
    ));
  };
  await renderProject('project-1');
  return {
    get current() { return current; },
    async switchProject(projectId, buffer) {
      await renderProject(projectId);
      await act(async () => current.replaceBuffers({ [buffer.projectRelativePath]: buffer }));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

function textFileBufferFixture(projectRelativePath: string, content: string, baseRevision: string): TextFileBuffer {
  return {
    projectRelativePath,
    content,
    language: 'markdown',
    wordWrap: false,
    dirty: true,
    saving: false,
    baseRevision,
    externalChange: false
  };
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

function projectTextFileWriteResult(
  projectRelativePath: string,
  content: string,
  revision: string
): Awaited<ReturnType<WorkbenchApiClient['writeProjectTextFile']>> {
  return {
    projectId: 'project-1',
    projectRevision: 2,
    file: {
      projectRelativePath,
      content,
      revision,
      size: content.length,
      mtimeMs: 1,
      language: 'markdown',
      mimeType: 'text/markdown'
    }
  };
}

function projectTextFile(
  projectRelativePath: string,
  content: string,
  revision: string
): Awaited<ReturnType<WorkbenchApiClient['readProjectTextFile']>> {
  return {
    projectRelativePath,
    content,
    revision,
    size: content.length,
    mtimeMs: 1,
    language: 'markdown',
    mimeType: 'text/markdown'
  };
}
