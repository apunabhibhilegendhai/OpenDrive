import type { ByteStream } from '@opendrive/shared';

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
  /** Relative path onto `https://api.telegram.org/file/bot<token>/<path>`. */
  filePath: string;
}

export interface TelegramMe {
  id: number;
  username: string;
}

export interface TelegramTransport {
  /** Uploads one part as a chat document and returns the server-assigned ids. */
  sendDocument(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    caption?: string;
  }): Promise<TelegramUploadReceipt>;

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
   * Base URL override for a self-hosted Local Bot API server, which lifts the 20 MiB
   * download ceiling (see docs/STORAGE-PROVIDERS.md). Defaults to api.telegram.org.
   */
  apiBaseUrl?: string;
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

  async sendDocument(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
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
      fileSize: typeof fileSize === 'number' ? fileSize : input.bytes.byteLength,
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
    const url = `${this.apiBase}/file/bot${this.options.botToken}/${filePath}`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET' });
    } catch (error) {
      throw new TelegramApiError(
        `Telegram file "${filePath}" could not be downloaded (network error).`,
        '',
        null,
        true,
        error,
      );
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 404) {
        throw new TelegramNotFoundError(
          `Telegram file "${filePath}" is unavailable (HTTP ${response.status}).`,
          response.status,
        );
      }
      throw new TelegramApiError(
        `Telegram file "${filePath}" download failed with HTTP ${response.status}.`,
        '',
        response.status,
        response.status >= 500,
      );
    }
    if (response.body === null) {
      throw new TelegramApiError(
        `Telegram file "${filePath}" returned an empty body.`,
        '',
        null,
        false,
      );
    }
    const body = response.body;
    return (async function* generate(): ByteStream {
      for await (const chunk of body) {
        yield chunk;
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
