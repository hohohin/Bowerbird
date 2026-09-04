/**
 * 最小 ambient 声明：让本契约包在不安装 @types/node 的情况下通过 tsc。
 * 运行时由 Node v24（类型剥离）提供真实实现。
 * 仅声明 M0 实际用到的 node API 子集；不追求与 @types/node 完全等价。
 */

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(
    name: string,
    options: { only?: boolean; todo?: boolean; skip?: boolean | string; concurrency?: number },
    fn: () => void | Promise<void>,
  ): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(a: unknown, b: unknown, message?: string): void;
  export function notEqual(a: unknown, b: unknown, message?: string): void;
  export function deepEqual(a: unknown, b: unknown, message?: string): void;
  export function deepStrictEqual(a: unknown, b: unknown, message?: string): void;
  export function throws(fn: () => unknown, matcher?: unknown, message?: string): void;
  export function rejects(fn: () => Promise<unknown>, matcher?: unknown, message?: string): Promise<void>;
  export function fail(message?: string): never;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomBytes(size: number): Uint8Array;
  export function randomUUID(): string;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: number | string, encoding: "utf8"): string;
  export function readFileSync(path: number | string): Uint8Array;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function mkdirSync(path: string, options: { recursive: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function copyFileSync(source: string, destination: string): void;
  export function symlinkSync(target: string, path: string, type?: "dir" | "junction"): void;
  export function unlinkSync(path: string): void;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): { mtimeMs: number };
  export function statfsSync(path: string): { blocks: number; bsize: number; bavail: number };
  export function utimesSync(path: string, atime: number, mtime: number): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(input: Uint8Array): Buffer;
    static from(input: string, encoding: "base64"): Buffer;
    toString(): string;
    toString(encoding: "base64"): string;
  }
}

declare module "node:zlib" {
  export function gzipSync(data: Uint8Array): Uint8Array;
  export function gunzipSync(data: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
}

declare module "node:child_process" {
  export interface ChildProcess {
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdin: { end(data?: string): void };
    readonly stdout: {
      setEncoding(encoding: "utf8"): void;
      on(event: "data", listener: (chunk: string) => void): void;
    };
    readonly stderr: {
      setEncoding(encoding: "utf8"): void;
      on(event: "data", listener: (chunk: string) => void): void;
    };
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "exit", listener: (code: number | null) => void): void;
    kill(signal?: "SIGKILL"): boolean;
  }
  export function spawn(
    command: string,
    args: string[],
    options: {
      env: Record<string, string>;
      cwd?: string;
      stdio: ["pipe", "pipe", "pipe"];
      windowsHide?: boolean;
    },
  ): ChildProcess;
}

declare module "node:stream" {
  export class PassThrough {
    end(data?: string): void;
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string) => void): void;
  }
  export class Readable {
    static toWeb(stream: unknown): unknown;
  }
  export class Writable {
    static toWeb(stream: unknown): unknown;
  }
}

declare module "@agentclientprotocol/sdk" {
  export const PROTOCOL_VERSION: number;
  export function ndJsonStream(writable: unknown, readable: unknown): unknown;
  export class ClientSideConnection {
    constructor(callbacks: () => unknown, stream: unknown);
  }
}

/** html-renderer 执行器测试用的最小 node:http 形状（环回假 renderer 服务）。 */
declare module "node:http" {
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string | Uint8Array): void;
    destroy(): void;
  }
  export interface IncomingMessage {
    readonly headers: Record<string, string | string[] | undefined>;
    readonly method?: string;
    readonly url?: string;
    on(event: "data", listener: (chunk: Uint8Array) => void): IncomingMessage;
    on(event: "end", listener: () => void): IncomingMessage;
    on(event: string, listener: (...args: never[]) => void): IncomingMessage;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): Server;
    listen(options: { host: string; port: number; exclusive?: boolean }, callback: () => void): Server;
    close(callback: (error?: Error) => void): Server;
    closeAllConnections(): void;
    address(): { port: number } | string | null;
    on(event: string, listener: (...args: never[]) => void): Server;
    once(event: string, listener: (...args: never[]) => void): Server;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): Server;
}

interface ImportMeta {
  /** Node ≥20.11 提供；本仓库 Node 24 运行时可用。 */
  readonly dirname: string;
}

declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
  argv: string[];
  platform: "win32" | string;
};

declare function setTimeout(callback: () => void, delayMs: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(encoding?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

interface AbortSignal {}

declare class URL {
  constructor(input: string);
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
}

interface Response {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
): Promise<Response>;
