interface Window {
  __adobe_cep__?: {
    evalScript(script: string, callback: (result: string) => void): void;
    getHostEnvironment?(): string;
    getSystemPath(pathType: string): string;
  };
  cep?: {
    encoding: {
      Base64: string;
      UTF8: string;
    };
    fs: {
      NO_ERROR: number;
      readFile(path: string, encoding: string): { err: number; data: string };
      makedir(path: string): { err: number };
      writeFile(path: string, data: string, encoding: string): { err: number };
      deleteFile(path: string): { err: number };
    };
  };
}

declare module '*.css';
