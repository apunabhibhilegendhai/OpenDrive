import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { normalize, sep } from 'node:path';
import type { ByteSource, ByteStream } from '@opendrive/shared';

/**
 * Transport seam between the Telegram storage provider and the Bot API.
 *
 * The provider never talks HTTP directly: every byte that crosses to/from Telegram goes
 * through this interface, so tests can substitute an in-memory fake and the provider
 * logic stays the thing under test. `TelegramHttpTransport` is the production path;
 * it knows the bot token and the target chat. Nothing else in the codebase should.
 */

export interface TelegramUploadReceipt {
  messageId: number;
  fileId: string;
  fileUniqueId: string;
  fileSize: number;
}

export interface TelegramFileInfo {
  fileId: string;
  fileUniqueId: string;
  fileSize: number;
  /**
   * Path to the stored bytes. Against the public (or non-`--local`) Bot API this is a
   * relative path onto `https://api.telegram.org/file/bot<token>/<path>`. A self-hosted
   * server run WITH `--local` returns an absolute on-disk path instead; `download()` reads
   * it from the local filesystem or rewrites it through `filesBaseUrl` (see
   * `TelegramHttpTransportOptions`).
   */
  filePath: string;
}

export interface TelegramMe {
  id: number;
  username: string;
}

export interface TelegramSendDocumentInput {
  filename: string;
  mimeType: string;
  caption?: string;
  /**
   * Bytes to upload. Multipart parts arrive as one buffer; a streamed whole object arrives
   * as a `ByteStream` and is transmitted without being materialised in memory.
   */
  source: ByteSource;
  /** Total byte count of the uploaded document, declared by the caller. */
  sizeBytes: number;
}

export interface TelegramTransport {
  /** Uploads one part as a chat document and returns the server-assigned ids. */
  sendDocument(input: TelegramSendDocumentInput): Promise<TelegramUploadReceipt>;

  /**
   * Resolves a `file_id` to a downloadable path. Throws `TelegramNotFoundError` when the
   * bytes are no longer servable. The standard Bot API cannot resolve files above 20 MiB,
   * which is why the provider keeps every part under that ceiling.
   */
  getFile(fileId: string): Promise<TelegramFileInfo>;

  /** Streams the bytes at a resolved file path. Each call returns a single-use stream. */
  download(filePath: string): Promise<ByteStream>;

  /** Removes a chat message; returns false when it was already absent. */
  deleteMessage(messageId: number): Promise<boolean>;

  /** Readiness probe: identifies the bot the token belongs to. */
  getMe(): Promise<TelegramMe>;
}

/**
 * Base failure of a Telegram HTTP call. `description` is Telegram's own error text and is
 * safe to log; the bot token is never included in any message.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly description: string,
    readonly errorCode: number | null,
    /** True when a retry with backoff may succeed (network drop, 5xx, rate limit). */
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TelegramApiError';
  }
}

/** Telegram reports the requested resource as absent (deleted message, purged file). */
export class TelegramNotFoundError extends TelegramApiError {
  constructor(description: string, errorCode: number | null, cause?: unknown) {
    super(
      `Telegram could not find the expected resource: ${description}`,
      description,
      errorCode,
      false,
      cause,
    );
    this.name = 'TelegramNotFoundError';
  }
}

/** Telegram refused the payload because it exceeds the API's file-size ceiling. */
export class TelegramPayloadTooLargeError extends TelegramApiError {
  constructor(description: string, errorCode: number | null, cause?: unknown) {
    super(
      `Telegram refused an oversized file: ${description}`,
      description,
      errorCode,
      false,
      cause,
    );
    this.name = 'TelegramPayloadTooLargeError';
  }
}

/** Telegram is throttling this bot; a backoff-and-retry can succeed. */
export class TelegramRateLimitedError extends TelegramApiError {
  constructor(description: string, errorCode: number | null, cause?: unknown) {
    super(`Telegram is rate limiting the bot: ${description}`, description, errorCode, true, cause);
    this.name = 'TelegramRateLimitedError';
  }
}

/** Maps a Telegram error description to the most precise failure class. */
export function classifyApiError(description: string, errorCode: number | null): TelegramApiError {
  const text = description.toLowerCase();
  if (/(not found|does not exist)/.test(text)) {
    return new TelegramNotFoundError(description, errorCode);
  }
  if (/(too big|too large|entity too large|payload too large)/.test(text)) {
    return new TelegramPayloadTooLargeError(description, errorCode);
  }
  if (errorCode === 429 || /too many requests|retry after|flood/.test(text)) {
    return new TelegramRateLimitedError(description, errorCode);
  }
  const retryable = errorCode === null || errorCode >= 500 || errorCode === 429;
  return new TelegramApiError(
    `Telegram API error (${errorCode ?? 'unknown'}): ${description}`,
    description,
    errorCode,
    retryable,
  );
}

interface TelegramEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

export interface TelegramHttpTransportOptions {
  botToken: string;
  /**
   * Target chat: a numeric id (`-1001234567890`) or a string handle (`@mychannel`).
   * The bot must be a member with rights to post documents.
   */
  chatId: string;
  /**
   * Base URL override for a self-hosted Local Bot API server, which can lift the 20 MiB
   * download ceiling when combined with `--local` (see docs/STORAGE-PROVIDERS.md). Defaults
   * to api.telegram.org.
   */
  apiBaseUrl?: string;
  /**
   * Base URL of a file server that serves the Local Bot API server's `--dir` (for example an
   * nginx `autoindex`/static mapping). Required to download files when the server runs with
   * `--local` — which makes `getFile` return absolute on-disk paths — and the API process
   * cannot read that disk itself. Combined with `workDir`, an absolute path is rewritten to
   * `${filesBaseUrl}/${path relative to workDir}`.
   */
  filesBaseUrl?: string;
  /**
   * The `--dir` value of the Local Bot API server. Used to relativise the absolute paths that
   * `--local` mode returns so they can be served through `filesBaseUrl`. Not needed when the
   * API reads the server's disk directly.
   */
  workDir?: string;
}

export class TelegramHttpTransport implements TelegramTransport {
  private readonly apiBase: string;

  constructor(private readonly options: TelegramHttpTransportOptions) {
    this.apiBase = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  }

  private botUrl(method: string): string {
    return `${this.apiBase}/bot${this.options.botToken}/${method}`;
  }

  private async request(method: string, init: RequestInit): Promise<TelegramEnvelope> {
    let response: Response;
    try {
      response = await fetch(this.botUrl(method), init);
    } catch (error) {
      throw new TelegramApiError(
        `Telegram API call "${method}" could not be completed (network error).`,
        '',
        null,
        true,
        error,
      );
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const envelope = (
      typeof payload === 'object' && payload !== null ? payload : {}
    ) as Partial<TelegramEnvelope>;
    if (envelope.ok !== true) {
      const description =
        typeof envelope.description === 'string'
          ? envelope.description
          : `HTTP ${response.status} without a Telegram error description`;
      const errorCode =
        typeof envelope.error_code === 'number' ? envelope.error_code : response.status;
      throw classifyApiError(description, errorCode);
    }
    return envelope as TelegramEnvelope;
  }

  async sendDocument(input: TelegramSendDocumentInput): Promise<TelegramUploadReceipt> {
    // A buffered part keeps using FormData/File; a streamed whole object is sent with a
    // hand-built multipart body so the bytes never have to materialise in memory.
    if (input.source instanceof Uint8Array) {
      return this.sendDocumentBytes({ ...input, bytes: input.source });
    }
    // Narrow from `ByteSource` to `ByteStream`: a `Uint8Array` would iterate as bytes.
    return this.sendDocumentStream({ ...input, source: input.source });
  }

  private async sendDocumentBytes(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    sizeBytes: number;
    caption?: string;
  }): Promise<TelegramUploadReceipt> {
    const form = new FormData();
    form.set('chat_id', this.options.chatId);
    // `BlobPart` is not a resolvable global type with the repository's ES2023 lib, so build
    // the file bytes as a plain ArrayBuffer and let the Blob/File constructors type the part.
    const copy = new Uint8Array(input.bytes.byteLength);
    copy.set(input.bytes);
    const file = new File([copy.buffer], input.filename, { type: input.mimeType });
    form.set('document', file);
    if (input.caption !== undefined && input.caption.length > 0) {
      form.set('caption', input.caption);
    }
    const envelope = await this.request('sendDocument', { method: 'POST', body: form });
    return this.parseSendDocumentEnvelope(envelope, input.sizeBytes);
  }

  /**
   * Streams a `ByteStream` whole-object upload as a multipart/form-data request without
   * materialising it: the body is a `ReadableStream` that frames the multipart parts around
   * the caller's chunks and is sent with `duplex: 'half'`. Backpressure flows through the
   * underlying socket, so a multi-gigabyte object is held nowhere in memory.
   */
  private async sendDocumentStream(
    input: TelegramSendDocumentInput & { source: ByteStream },
  ): Promise<TelegramUploadReceipt> {
    const boundary = `----od${randomUUID().replaceAll('-', '')}`;
    const crlf = '\r\n';
    const safeFilename = input.filename
      .replaceAll('"', '')
      .replaceAll('\r', '')
      .replaceAll('\n', '');
    const openParts =
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="chat_id"${crlf}${crlf}` +
      `${this.options.chatId}${crlf}` +
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="document"; filename="${safeFilename}"${crlf}` +
      `Content-Type: ${input.mimeType}${crlf}${crlf}`;
    const captionPart =
      input.caption !== undefined && input.caption.length > 0
        ? `${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="caption"${crlf}${crlf}${input.caption}${crlf}`
        : '';
    const closing = `${crlf}--${boundary}--${crlf}`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(openParts));
          for await (const chunk of input.source) controller.enqueue(chunk);
          if (captionPart.length > 0) controller.enqueue(encoder.encode(captionPart));
          controller.enqueue(encoder.encode(closing));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    // TS's DOM `RequestInit` knows neither a `ReadableStream` body nor `duplex`; Node's
    // undici fetch accepts both, so assert the extras at the call site.
    const envelope = await this.request('sendDocument', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    } as unknown as RequestInit);
    return this.parseSendDocumentEnvelope(envelope, input.sizeBytes);
  }

  private parseSendDocumentEnvelope(
    envelope: TelegramEnvelope,
    fallbackSizeBytes: number,
  ): TelegramUploadReceipt {
    const result = envelope.result as {
      message_id?: number;
      document?: { file_id?: string; file_unique_id?: string; file_size?: number };
    };
    const messageId = result?.message_id;
    const fileId = result?.document?.file_id;
    if (typeof messageId !== 'number' || typeof fileId !== 'string' || fileId.length === 0) {
      throw new TelegramApiError(
        'Telegram sendDocument succeeded but the response lacked a message_id/document file_id.',
        '',
        null,
        false,
      );
    }
    const fileSize = result?.document?.file_size;
    return {
      messageId,
      fileId,
      fileUniqueId: result?.document?.file_unique_id ?? '',
      fileSize: typeof fileSize === 'number' ? fileSize : fallbackSizeBytes,
    };
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
    const envelope = await this.request('getFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const result = envelope.result as {
      file_id?: string;
      file_unique_id?: string;
      file_size?: number;
      file_path?: string;
    };
    const resolvedFileId = result?.file_id;
    const filePath = result?.file_path;
    if (
      typeof resolvedFileId !== 'string' ||
      typeof filePath !== 'string' ||
      filePath.length === 0
    ) {
      throw new TelegramApiError(
        'Telegram getFile succeeded but returned no downloadable file_path.',
        '',
        null,
        false,
      );
    }
    return {
      fileId: resolvedFileId,
      fileUniqueId: result?.file_unique_id ?? '',
      fileSize: typeof result?.file_size === 'number' ? result.file_size : 0,
      filePath,
    };
  }

  async download(filePath: string): Promise<ByteStream> {
    if (isAbsoluteFilePath(filePath)) return this.downloadLocalFile(filePath);
    return this.downloadFileUrl(
      `${this.apiBase}/file/bot${this.options.botToken}/${filePath}`,
      filePath,
    );
  }

  /**
   * A Local Bot API server run with `--local` returns absolute on-disk paths from `getFile`.
   * Read them straight from disk when the API process shares the server's filesystem;
   * otherwise rewrite them through `filesBaseUrl` (an nginx or similar file server serving
   * the server's `--dir`).
   */
  private async downloadLocalFile(filePath: string): Promise<ByteStream> {
    const filesBaseUrl = this.options.filesBaseUrl;
    if (filesBaseUrl !== undefined && filesBaseUrl.length > 0) {
      return this.downloadFileUrl(
        `${filesBaseUrl.replace(/\/+$/, '')}/${this.relativeToWorkDir(filePath)}`,
        filePath,
      );
    }
    return localFileStream(filePath);
  }

  /** Turns an absolute `--local` path into a URL-safe path relative to the server's `--dir`. */
  private relativeToWorkDir(filePath: string): string {
    const workDir = this.options.workDir;
    if (workDir !== undefined && workDir.length > 0) {
      const normalizedFile = normalize(filePath);
      const normalizedRoot = normalize(workDir).replace(/[\\/]+$/, '');
      if (normalizedFile.startsWith(normalizedRoot + sep)) {
        return normalizedFile
          .slice(normalizedRoot.length + 1)
          .split(sep)
          .join('/');
      }
    }
    throw new TelegramApiError(
      `A --local Bot API server returned "${filePath}", which can only be served as a URL ` +
        "with a TELEGRAM_WORK_DIR matching the server's --dir. Set TELEGRAM_WORK_DIR (and " +
        'TELEGRAM_FILES_BASE_URL), or run the API on the same host so the path can be read ' +
        'from disk.',
      '',
      null,
      false,
    );
  }

  private async downloadFileUrl(url: string, label: string): Promise<ByteStream> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET' });
    } catch (error) {
      throw new TelegramApiError(
        `Telegram file "${label}" could not be downloaded (network error).`,
        '',
        null,
        true,
        error,
      );
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 404) {
        throw new TelegramNotFoundError(
          `Telegram file "${label}" is unavailable (HTTP ${response.status}).`,
          response.status,
        );
      }
      throw new TelegramApiError(
        `Telegram file "${label}" download failed with HTTP ${response.status}.`,
        '',
        response.status,
        response.status >= 500,
      );
    }
    if (response.body === null) {
      throw new TelegramApiError(
        `Telegram file "${label}" returned an empty body.`,
        '',
        null,
        false,
      );
    }
    const body = response.body;
    return (async function* generate(): ByteStream {
      try {
        for await (const chunk of body) {
          yield chunk;
        }
      } catch (error) {
        // `fetch` already resolved, so the connection dropped while the body was streaming.
        // A raw undici `TypeError: terminated` would otherwise escape every caller's error
        // mapping; classify it as retryable so an interrupted read can be retried.
        if (error instanceof TelegramApiError) throw error;
        throw new TelegramApiError(
          `Telegram file "${label}" download was interrupted before it completed.`,
          '',
          null,
          true,
          error,
        );
      }
    })();
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    const envelope = await this.request('deleteMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.options.chatId, message_id: messageId }),
    });
    // `ok:true` means the message was deleted (or had already vanished).
    return envelope.ok === true;
  }

  async getMe(): Promise<TelegramMe> {
    const envelope = await this.request('getMe', { method: 'GET' });
    const result = envelope.result as { id?: number; username?: string };
    if (typeof result?.id !== 'number') {
      throw new TelegramApiError('Telegram getMe succeeded without a bot id.', '', null, false);
    }
    return { id: result.id, username: typeof result.username === 'string' ? result.username : '' };
  }
}

/**
 * True for the absolute on-disk paths that a `--local` Bot API server returns: POSIX
 * `/...` or a Windows drive path `C:\...`. The public (cloud) API never returns these.
 */
function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

/** Streams a local file, mapping filesystem failures onto the transport's error classes. */
function localFileStream(filePath: string): ByteStream {
  return (async function* generate(): ByteStream {
    try {
      for await (const chunk of createReadStream(filePath)) {
        yield chunk;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new TelegramNotFoundError(`Local file "${filePath}" does not exist.`, null, error);
      }
      throw new TelegramApiError(
        `Local file "${filePath}" could not be read.`,
        '',
        null,
        true,
        error,
      );
    }
  })();
}
