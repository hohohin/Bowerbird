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
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(a: unknown, b: unknown, message?: string): void;
  export function notEqual(a: unknown, b: unknown, message?: string): void;
  export function deepEqual(a: unknown, b: unknown, message?: string): void;
  export function deepStrictEqual(a: unknown, b: unknown, message?: string): void;
  export function throws(fn: () => unknown, matcher?: unknown, message?: string): void;
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
  export function readFileSync(path: number | string, encoding: "utf8"): string;
}

declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare function setTimeout(callback: () => void, delayMs: number): unknown;
declare function clearTimeout(handle: unknown): void;
