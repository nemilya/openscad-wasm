export interface InitOptions {
  noInitialRun?: boolean;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  locateFile?: (path: string, prefix: string) => string;
  monitorRunDependencies?: (left: number) => void;
  onExit?: (status: number) => void;
  // The emscripten module accepts many more settings than the ones above.
  [key: string]: unknown;
}

export interface OpenSCAD {
  callMain(args: Array<string>): number;
  FS: FS;
  locateFile?: (path: string, prefix: string) => string;
}

export interface FS {
  mkdir(path: string): void;
  rename(oldpath: string, newpath: string): void;
  rmdir(path: string): void;
  stat(path: string): unknown; //TODO: add stat result obj
  readFile(path: string): string | Uint8Array;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: string | ArrayBufferView): void;
  unlink(path: string): void;
}

type ModuleFactory = (moduleArg?: InitOptions) => Promise<OpenSCAD>;
let factory: Promise<ModuleFactory> | undefined;

function loadFactory(): Promise<ModuleFactory> {
  const url = new URL(`./openscad.wasm.js`, import.meta.url).href;
  return import(url).then((module) => module.default as ModuleFactory);
}

async function OpenSCAD(options?: InitOptions): Promise<OpenSCAD> {
  if (!factory) {
    factory = loadFactory().catch((error) => {
      // Don't cache a rejected import, so a failed load can be retried.
      factory = undefined;
      throw error;
    });
  }
  const createModule = await factory;
  return await createModule({
    noInitialRun: true,
    locateFile: (path: string) => new URL(`./${path}`, import.meta.url).href,
    ...options,
  });
}

let buildInfo: Promise<Array<string>> | undefined;

export function getBuildInfo(): Promise<Array<string>> {
  if (!buildInfo) {
    buildInfo = readBuildInfo().catch((error) => {
      // Don't cache a failure, so it can be retried.
      buildInfo = undefined;
      throw error;
    });
  }
  return buildInfo;
}

async function readBuildInfo(): Promise<Array<string>> {
  const lines: Array<string> = [];
  const instance = await OpenSCAD({
    noInitialRun: true,
    print: (text: string) => lines.push(text),
    printErr: () => {},
  });

  instance.callMain(["--info"]);
  return lines;
}

export default OpenSCAD;
