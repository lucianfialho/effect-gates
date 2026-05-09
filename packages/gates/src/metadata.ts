import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";

export interface FileMetadata {
  readonly path: string;
  readonly size: number;
  readonly created: number;
  readonly modified: number;
  readonly accessed: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly permissions: string;
}

export interface DirectoryMetadata {
  readonly path: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalSize: number;
  readonly files: FileMetadata[];
}

export class MetadataError {
  readonly _tag = "MetadataError";
  constructor(
    readonly code: string,
    readonly message: string
  ) {}
}

const formatPermissions = (mode: number): string => {
  const permissions: string[] = [];

  permissions.push((mode & 0o400) ? "r" : "-");
  permissions.push((mode & 0o200) ? "w" : "-");
  permissions.push((mode & 0o100) ? "x" : "-");
  permissions.push((mode & 0o040) ? "r" : "-");
  permissions.push((mode & 0o020) ? "w" : "-");
  permissions.push((mode & 0o010) ? "x" : "-");
  permissions.push((mode & 0o004) ? "r" : "-");
  permissions.push((mode & 0o002) ? "w" : "-");
  permissions.push((mode & 0o001) ? "x" : "-");

  return permissions.join("");
};

export const getFileMetadata = (
  filePath: string
): Effect.Effect<FileMetadata, MetadataError> =>
  Effect.try_({
    try: () => {
      const stats = fs.statSync(filePath);
      return {
        path: filePath,
        size: stats.size,
        created: stats.birthtime.getTime(),
        modified: stats.mtime.getTime(),
        accessed: stats.atime.getTime(),
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        permissions: formatPermissions(stats.mode),
      };
    },
    catch: (error) => new MetadataError("STAT_ERROR", String(error)),
  });

export const getDirectoryMetadata = (
  dirPath: string,
  options: { recursive?: boolean; maxDepth?: number } = {}
): Effect.Effect<DirectoryMetadata, MetadataError> =>
  Effect.try_({
    try: () => {
      const recursive = options.recursive ?? false;
      const maxDepth = options.maxDepth ?? Infinity;

      let fileCount = 0;
      let directoryCount = 0;
      let totalSize = 0;
      const files: FileMetadata[] = [];

      const walkDir = (currentPath: string, depth: number): void => {
        if (depth > maxDepth) return;

        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          try {
            const stats = fs.statSync(fullPath);
            const metadata: FileMetadata = {
              path: fullPath,
              size: stats.size,
              created: stats.birthtime.getTime(),
              modified: stats.mtime.getTime(),
              accessed: stats.atime.getTime(),
              isFile: stats.isFile(),
              isDirectory: stats.isDirectory(),
              isSymbolicLink: stats.isSymbolicLink(),
              permissions: formatPermissions(stats.mode),
            };

            files.push(metadata);

            if (stats.isFile()) {
              fileCount++;
              totalSize += stats.size;
            } else if (stats.isDirectory()) {
              directoryCount++;
              if (recursive) {
                walkDir(fullPath, depth + 1);
              }
            }
          } catch {
            // Skip files we can't stat
          }
        }
      };

      walkDir(dirPath, 0);

      return {
        path: dirPath,
        fileCount,
        directoryCount,
        totalSize,
        files,
      };
    },
    catch: (error) => new MetadataError("WALK_ERROR", String(error)),
  });
