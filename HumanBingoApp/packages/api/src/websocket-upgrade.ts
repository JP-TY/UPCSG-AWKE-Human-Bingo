import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { RealtimeSocket } from './realtime.js';
import type { WebSocketUpgradeHandler } from './runtime.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ACCEPT_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CODE_NORMAL_CLOSURE = 1000;
const CODE_PROTOCOL_ERROR = 1002;
const CODE_UNSUPPORTED_DATA = 1003;
const CODE_MESSAGE_TOO_BIG = 1009;

export interface WebSocketUpgradeOptions {
  readonly maxMessageBytes?: number;
}

export type WebSocketConnection = RealtimeSocket;

/**
 * Server-side RFC 6455 upgrade adapter. The listener receives the upgrade
 * request and a connection whose send/close/onMessage/onClose surface matches
 * the realtime gateway socket contract. Client frames are validated: missing
 * masking, reserved bits, or unsupported payload types close the connection.
 */
export const createWebSocketUpgradeHandler = (
  listener: (request: IncomingMessage, connection: WebSocketConnection) => void,
  options: WebSocketUpgradeOptions = {},
): WebSocketUpgradeHandler => {
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1024)
    throw new RangeError('maxMessageBytes must be an integer of at least 1024');

  return {
    handleUpgrade(request, stream, head) {
      const key = request.headers['sec-websocket-key'];
      if (
        typeof key !== 'string' ||
        !ACCEPT_KEY_PATTERN.test(key) ||
        request.headers['sec-websocket-version'] !== '13' ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !connectionHeaderHasUpgrade(request.headers.connection)
      ) {
        stream.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        (stream as Socket).destroy();
        return;
      }
      const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
      stream.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const connection = new FrameConnection(stream as Socket, maxMessageBytes);
      if (head.length > 0) connection.ingest(head);
      listener(request, connection);
    },
  };
};

const connectionHeaderHasUpgrade = (value: string | string[] | undefined): boolean => {
  const parts = Array.isArray(value) ? value : [value ?? ''];
  return parts.some((part) =>
    part
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .includes('upgrade'),
  );
};

const encodeCloseFrame = (code: number, reason: string): Buffer => {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const length = 2 + reasonBytes.length;
  const frame = Buffer.alloc(2 + length);
  frame[0] = 0x80 | OP_CLOSE;
  frame[1] = length;
  frame.writeUInt16BE(code, 2);
  reasonBytes.copy(frame, 4);
  return frame;
};

class FrameConnection implements WebSocketConnection {
  private closed = false;
  private finished = false;
  private buffer = Buffer.alloc(0);
  private readonly fragments: Buffer[] = [];
  private fragmentType = 0;
  private fragmentBytes = 0;
  private readonly messageListeners = new Set<(data: string) => void>();
  private readonly closeListeners = new Set<() => void>();

  public constructor(
    private readonly socket: Socket,
    private readonly maxMessageBytes: number,
  ) {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.ingest(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
    socket.resume();
  }

  public send(data: string): void {
    if (this.closed) return;
    const payload = Buffer.from(data, 'utf8');
    if (payload.length > this.maxMessageBytes) {
      this.close(CODE_MESSAGE_TOO_BIG, 'Message is too large');
      return;
    }
    const frame = encodeDataFrame(OP_TEXT, payload);
    this.socket.write(frame);
  }

  public close(code = CODE_NORMAL_CLOSURE, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeCloseFrame(code, reason.slice(0, 123)));
    } catch {
      // The socket may already be destroyed; finish closes listeners regardless.
    }
    this.socket.destroy();
    this.finish();
  }

  public onMessage(listener: (data: string) => void): void {
    this.messageListeners.add(listener);
  }

  public onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  public ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
    while (!this.closed) {
      const parsed = this.tryReadFrame();
      if (parsed === null) return;
    }
  }

  /** Returns null when more bytes are needed. */
  private tryReadFrame(): { readonly payload: Buffer; readonly opcode: number } | null {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const reserved = (first & 0x70) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    const isControl = opcode >= 0x8;
    if (reserved || (isControl && (length > 125 || !fin))) {
      this.close(CODE_PROTOCOL_ERROR, 'Protocol violation');
      return null;
    }

    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      const wide = this.buffer.readBigUInt64BE(offset);
      offset += 8;
      if (wide > BigInt(this.maxMessageBytes)) {
        this.close(CODE_MESSAGE_TOO_BIG, 'Message is too large');
        return null;
      }
      length = Number(wide);
    }

    if (!masked) {
      this.close(CODE_PROTOCOL_ERROR, 'Protocol violation');
      return null;
    }
    if (length > this.maxMessageBytes) {
      this.close(CODE_MESSAGE_TOO_BIG, 'Message is too large');
      return null;
    }
    if (this.buffer.length < offset + 4 + length) return null;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    this.buffer = this.buffer.subarray(offset + length);

    if (isControl) {
      this.handleControl(opcode, payload);
      return { payload, opcode };
    }
    this.handleData(fin, opcode, payload);
    return { payload, opcode };
  }

  private handleControl(opcode: number, payload: Buffer): void {
    if (opcode === OP_PING) {
      if (!this.closed) this.socket.write(encodeDataFrame(OP_PONG, payload));
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : CODE_NORMAL_CLOSURE;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.close(code, reason);
    }
  }

  private handleData(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OP_BINARY) {
      this.close(CODE_UNSUPPORTED_DATA, 'Binary frames are not supported');
      return;
    }
    if (opcode === OP_TEXT) {
      if (this.fragmentType !== 0) {
        this.close(CODE_PROTOCOL_ERROR, 'Unexpected new message during fragmented message');
        return;
      }
      this.fragmentType = OP_TEXT;
      this.fragmentBytes = 0;
    } else if (opcode !== OP_CONTINUATION || this.fragmentType === 0) {
      this.close(CODE_PROTOCOL_ERROR, 'Unexpected continuation frame');
      return;
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.close(CODE_MESSAGE_TOO_BIG, 'Message is too large');
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments.length = 0;
    this.fragmentType = 0;
    this.fragmentBytes = 0;
    const text = message.toString('utf8');
    for (const listener of [...this.messageListeners]) listener(text);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }
}

const encodeDataFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload], header.length + length);
};
