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
  export function randomUUID(): string;
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
}

declare module "node:os" {
  export function tmpdir(): string;
}

/** html-renderer 执行器测试用的最小 node:http 形状（环回假 renderer 服务）。 */
declare module "node:http" {
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string): void;
    destroy(): void;
  }
  export interface IncomingMessage {
    on(event: "data", listener: (chunk: Uint8Array) => void): IncomingMessage;
    on(event: "end", listener: () => void): IncomingMessage;
    on(event: string, listener: (...args: never[]) => void): IncomingMessage;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): Server;
    close(callback: () => void): Server;
    address(): { port: number } | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
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
  exitCode?: number;
  argv: string[];
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
