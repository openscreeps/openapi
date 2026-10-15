// The generator validates untrusted documents at runtime before rendering client sources.
export interface GeneratedClientFiles {
  'schema.ts': string;
  'index.ts': string;
}

export interface GenerateClientFilesOptions {
  document: unknown;
  name: string;
  runtime: string;
}

export type GenerateClientOptions = {
  output: string;
  name: string;
  runtime?: string;
  check?: boolean;
} & ({ document: unknown; input?: never } | { input: string; document?: never });

export interface GeneratedClientResult {
  files: string[];
  stale: string[];
}

export function generateClientFiles(
  options: GenerateClientFilesOptions,
): Promise<GeneratedClientFiles>;
export function generateClient(options: GenerateClientOptions): Promise<GeneratedClientResult>;
