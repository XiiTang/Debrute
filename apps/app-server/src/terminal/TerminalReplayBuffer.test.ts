import { describe, expect, it } from 'vitest';
import { TerminalReplayBuffer } from './TerminalReplayBuffer.js';

describe('TerminalReplayBuffer', { tags: ['terminal'] }, () => {
  it('assigns monotonic sequence numbers', () => {
    const buffer = new TerminalReplayBuffer({ maxLines: 10_000, maxBytes: 4 * 1024 * 1024 });

    const first = buffer.append('one\n');
    const second = buffer.append('two\n');

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(buffer.snapshot()).toEqual({
      chunks: [
        { sequence: 1, data: 'one\n' },
        { sequence: 2, data: 'two\n' }
      ],
      lastSequence: 2
    });
  });

  it('trims older chunks by line cap without rewriting sequence numbers', () => {
    const buffer = new TerminalReplayBuffer({ maxLines: 2, maxBytes: 4 * 1024 * 1024 });

    buffer.append('one\n');
    buffer.append('two\n');
    buffer.append('three\n');

    expect(buffer.snapshot()).toEqual({
      chunks: [
        { sequence: 2, data: 'two\n' },
        { sequence: 3, data: 'three\n' }
      ],
      lastSequence: 3
    });
  });

  it('trims older chunks by UTF-8 byte cap', () => {
    const buffer = new TerminalReplayBuffer({ maxLines: 10_000, maxBytes: 6 });

    buffer.append('aa');
    buffer.append('bb');
    buffer.append('cc');
    buffer.append('dd');

    expect(buffer.snapshot()).toEqual({
      chunks: [
        { sequence: 2, data: 'bb' },
        { sequence: 3, data: 'cc' },
        { sequence: 4, data: 'dd' }
      ],
      lastSequence: 4
    });
  });

  it('keeps the newest suffix when one chunk exceeds the byte cap', () => {
    const buffer = new TerminalReplayBuffer({ maxLines: 10_000, maxBytes: 6 });

    const appended = buffer.append('aabbccdd');

    expect(appended).toEqual({ sequence: 1, data: 'aabbccdd' });
    expect(buffer.snapshot()).toEqual({
      chunks: [
        { sequence: 1, data: 'bbccdd' }
      ],
      lastSequence: 1
    });
  });
});
