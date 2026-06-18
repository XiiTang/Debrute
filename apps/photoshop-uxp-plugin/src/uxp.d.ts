declare function require(id: 'photoshop'): {
  app: {
    activeDocument: {
      id: number;
      title: string;
      layers: Array<{ id: number; name: string; typename: string; layers?: unknown[] }>;
      activeLayers: Array<{ id: number; name: string; typename: string; layers?: unknown[] }>;
    } | null;
    documents: unknown[];
  };
  action: {
    batchPlay(descriptors: unknown[], options: Record<string, unknown>): Promise<unknown[]>;
  };
  core: {
    executeAsModal<T>(targetFunction: () => Promise<T> | T, options: { commandName: string; timeOut?: number }): Promise<T>;
  };
  imaging: {
    getPixels(options: Record<string, unknown>): Promise<{
      imageData: {
        width: number;
        height: number;
        components: number;
        getData(): Promise<Uint8Array>;
        dispose(): void;
      };
      sourceBounds: { left: number; top: number; right: number; bottom: number };
    }>;
  };
};

declare function require(id: 'uxp'): {
  storage: {
    localFileSystem: {
      getTemporaryFolder(): Promise<{
        createFile(name: string, options?: { overwrite?: boolean }): Promise<{
          nativePath?: string;
          write(content: ArrayBuffer | Uint8Array, options?: { format?: unknown }): Promise<void>;
        }>;
      }>;
      createSessionToken(entry: unknown): string;
    };
    formats: {
      binary: symbol;
    };
  };
};

declare module '*.css';
