declare module "pako" {
  export function deflate(input: Uint8Array, options: { level: number }): Uint8Array;
  export class Inflate {
    constructor(options: { chunkSize: number });
    onData(chunk: Uint8Array): void;
    push(input: Uint8Array, final: boolean): boolean;
    ended: boolean;
    err: number;
  }
}
