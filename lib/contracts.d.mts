// Contract composition validates its JSON inputs at runtime and throws one Error listing every
// violation, so documents and profiles are typed as plain JSON objects.
export type JsonObject = { [key: string]: unknown };

export interface OperationEntry {
  method: string;
  path: string;
  operationId: string | undefined;
  operation: JsonObject;
}

export declare const OPERATION_METHODS: readonly string[];
export function listOperations(document: unknown): OperationEntry[];
export function mergePatch(target: unknown, patch: unknown): unknown;
export function assembleProfile(
  index: JsonObject,
  fragments: ReadonlyArray<readonly [string, JsonObject]>,
): JsonObject;
export function composeProfile(
  official: JsonObject,
  profile: JsonObject,
  extensions?: JsonObject,
): JsonObject;
export function composeSocketProfile(official: JsonObject, profile: JsonObject): JsonObject;
