/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ByteRange } from '@opendrive/shared';
import type { ApiClient } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { downloadFileContent } from './download.js';

/** A deterministic byte sequence, so a window taken from the wrong offset cannot pass by luck. */
function sequence(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + 1) % 251;
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The Node fetch types do not accept a generic-tagged `Uint8Array` as a body, though it is exactly
 * the binary `BodyInit` a real response carries; this is the narrow assertion that says so.
 */
function body(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

/** Serves `source` as real `206` responses, recording every range the client asks for. */
function rangedClient(source: Uint8Array): { client: ApiClient; ranges: ByteRange[] } {
  const ranges: ByteRange[] = [];
  const client = {
    openContent: async (_fileId: string, options: { range?: ByteRange } = {}) => {
      const range = options.range ?? { start: 0, endInclusive: source.byteLength - 1 };
      ranges.push(range);
      return new Response(body(source.subarray(range.start, range.endInclusive + 1)), {
        status: 206,
        headers: {
          'content-range': `bytes ${range.start}-${range.endInclusive}/${source.byteLength}`,
        },
      });
    },
  } as unknown as ApiClient;
  return { client, ranges };
}

/** Installs a File System Access picker whose writable collects the streamed chunks. */
function installPicker(name = 'saved.bin'): { written: Uint8Array[]; restore: () => void } {
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk.slice());
    },
  });
  const previous = window.showSaveFilePicker;
  window.showSaveFilePicker = async () =>
    ({ name, createWritable: async () => writable }) as unknown as FileSystemFileHandle;
  return {
    written,
    restore: () => {
      window.showSaveFilePicker = previous;
    },
  };
}

function target(sizeBytes?: number): { id: string; filename: string; sizeBytes?: number } {
  return {
    id: 'file_00000000000000000000000001',
    filename: 'x.bin',
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.showSaveFilePicker = undefined;
});

describe('downloadFileContent', () => {
  it('fetches a large object in bounded windows and writes them in order', async () => {
    const source = sequence(10);
    const { client, ranges } = rangedClient(source);
    const picker = installPicker();
    try {
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 4,
      });
      expect(outcome).toEqual({ kind: 'saved', filename: 'saved.bin', streamed: true });
      expect(ranges).toEqual([
        { start: 0, endInclusive: 3 },
        { start: 4, endInclusive: 7 },
        { start: 8, endInclusive: 9 },
      ]);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('retries a window that fails transiently instead of restarting the download', async () => {
    const source = sequence(10);
    const { client, ranges } = rangedClient(source);
    const original = client.openContent.bind(client);
    let calls = 0;
    client.openContent = async (fileId, options) => {
      calls += 1;
      if (calls === 2) throw new NetworkError('offline');
      return original(fileId, options);
    };
    const picker = installPicker();
    try {
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 4,
        retryBaseDelayMs: 0,
      });
      expect(outcome.kind).toBe('saved');
      expect(ranges).toHaveLength(3);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('gives up on a window that keeps failing', async () => {
    const source = sequence(10);
    const { client } = rangedClient(source);
    client.openContent = async () => {
      throw new NetworkError('offline');
    };
    const picker = installPicker();
    try {
      await expect(
        downloadFileContent(client, target(source.byteLength), undefined, {
          windowBytes: 4,
          retryBaseDelayMs: 0,
        }),
      ).rejects.toBeInstanceOf(NetworkError);
    } finally {
      picker.restore();
    }
  });

  it('falls back to the whole object when a server ignores Range on the first window', async () => {
    const source = sequence(10);
    let calls = 0;
    const client = {
      openContent: async () => {
        calls += 1;
        return new Response(body(source), { status: 200 });
      },
    } as unknown as ApiClient;
    const picker = installPicker();
    try {
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 4,
      });
      expect(outcome).toEqual({ kind: 'saved', filename: 'saved.bin', streamed: true });
      expect(calls).toBe(1);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('refuses a whole-object answer once a range has already been written', async () => {
    const source = sequence(10);
    let calls = 0;
    const client = {
      openContent: async () => {
        calls += 1;
        return calls === 1
          ? new Response(body(source.subarray(0, 4)), { status: 206 })
          : new Response(body(source), { status: 200 });
      },
    } as unknown as ApiClient;
    const picker = installPicker();
    try {
      await expect(
        downloadFileContent(client, target(source.byteLength), undefined, {
          windowBytes: 4,
          retryBaseDelayMs: 0,
        }),
      ).rejects.toBeInstanceOf(NetworkError);
    } finally {
      picker.restore();
    }
  });

  it('uses one request when the size is unknown', async () => {
    const source = sequence(10);
    const { client, ranges } = rangedClient(source);
    const picker = installPicker();
    try {
      await downloadFileContent(client, target(), undefined, { windowBytes: 4 });
      expect(ranges).toEqual([{ start: 0, endInclusive: 9 }]);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('reports a cancelled picker as cancelled, not a failure', async () => {
    const source = sequence(10);
    const { client } = rangedClient(source);
    window.showSaveFilePicker = async () => {
      throw new DOMException('Aborted', 'AbortError');
    };
    const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
      windowBytes: 4,
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('buffers through the same windows when the browser has no picker', async () => {
    const source = sequence(10);
    const { client, ranges } = rangedClient(source);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
      windowBytes: 4,
    });

    expect(outcome).toEqual({ kind: 'saved', filename: 'x.bin', streamed: false });
    expect(ranges).toHaveLength(3);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('keeps the bytes a window delivered before it was cut, and continues from there', async () => {
    const source = sequence(12);
    const ranges: ByteRange[] = [];
    let calls = 0;
    const client = {
      openContent: async (_fileId: string, options: { range?: ByteRange } = {}) => {
        const range = options.range ?? { start: 0, endInclusive: source.byteLength - 1 };
        ranges.push(range);
        calls += 1;
        if (calls !== 1) {
          return new Response(body(source.subarray(range.start, range.endInclusive + 1)), {
            status: 206,
          });
        }
        // The first window is cut after five of the twelve bytes it promised.
        let pulls = 0;
        const cut = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(source.subarray(0, 5));
            else controller.error(new Error('edge cut'));
          },
        });
        return new Response(cut, { status: 206 });
      },
    } as unknown as ApiClient;
    const picker = installPicker();
    try {
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 12,
        retryBaseDelayMs: 0,
      });
      expect(outcome.kind).toBe('saved');
      expect(ranges).toEqual([
        { start: 0, endInclusive: 11 },
        { start: 5, endInclusive: 11 },
      ]);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('retries an edge timeout (524) instead of failing the download', async () => {
    const source = sequence(10);
    const { client } = rangedClient(source);
    const original = client.openContent.bind(client);
    let calls = 0;
    client.openContent = async (fileId, options) => {
      calls += 1;
      if (calls === 1) {
        throw new ApiError({
          status: 524,
          code: 'UNEXPECTED_RESPONSE',
          detail: 'origin timed out',
        });
      }
      return original(fileId, options);
    };
    const picker = installPicker();
    try {
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 10,
        retryBaseDelayMs: 0,
      });
      expect(outcome.kind).toBe('saved');
      expect(calls).toBe(2);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });

  it('cuts a stalled window at the time budget and keeps the bytes that did arrive', async () => {
    const source = sequence(10);
    const ranges: ByteRange[] = [];
    let calls = 0;
    const client = {
      openContent: async (_fileId: string, options: { range?: ByteRange } = {}) => {
        const range = options.range ?? { start: 0, endInclusive: source.byteLength - 1 };
        ranges.push(range);
        calls += 1;
        if (calls !== 1) {
          return new Response(body(source.subarray(range.start, range.endInclusive + 1)), {
            status: 206,
          });
        }
        // The first window sends four bytes and then goes silent: no further chunk ever arrives.
        let pulls = 0;
        const stalled = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(source.subarray(0, 4));
            else return new Promise<void>(() => {});
          },
        });
        return new Response(stalled, { status: 206 });
      },
    } as unknown as ApiClient;
    const picker = installPicker();
    try {
      const startedAt = Date.now();
      const outcome = await downloadFileContent(client, target(source.byteLength), undefined, {
        windowBytes: 10,
        windowBudgetMs: 50,
        retryBaseDelayMs: 0,
      });
      expect(outcome.kind).toBe('saved');
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(ranges).toEqual([
        { start: 0, endInclusive: 9 },
        { start: 4, endInclusive: 9 },
      ]);
      expect(concat(picker.written)).toEqual(source);
    } finally {
      picker.restore();
    }
  });
});
