/*
 * mpegts.js ships a CommonJS-style `d.ts/mpegts.d.ts` (`export default Mpegts`). Under this
 * workspace's `module: NodeNext` resolution that declaration is read as a CommonJS module, so a
 * default import resolves to the *module namespace* (`{ default: ... }`) rather than to the player
 * factory, and every member access on it is an error-typed `any`. This ambient declaration
 * describes the surface this app actually uses, matching the runtime shape Vite gives the UMD
 * bundle (`module.exports` as the default export).
 */

declare module 'mpegts.js' {
  export interface MediaDataSource {
    type: string;
    url: string;
    isLive?: boolean;
    cors?: boolean;
  }

  export interface Config {
    enableWorker?: boolean;
  }

  export interface Player {
    attachMediaElement(element: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    destroy(): void;
    play(): Promise<void>;
    pause(): void;
  }

  export function createPlayer(dataSource: MediaDataSource, config?: Config): Player;
  export function isSupported(): boolean;

  const mpegts: {
    createPlayer: typeof createPlayer;
    isSupported: typeof isSupported;
  };

  export default mpegts;
}
