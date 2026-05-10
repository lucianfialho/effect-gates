import { Effect } from "effect";

export interface DedupOptions {
  readonly comparator?: (a: string, b: string) => boolean;
}

export class ReadDedupError {
  readonly _tag = "ReadDedupError";
  constructor(
    readonly code: string,
    readonly message: string
  ) {}
}

export const dedupLines = (
  lines: string[],
  options: DedupOptions = {}
): Effect.Effect<string[], ReadDedupError> =>
  Effect.succeed(lines).pipe(
    Effect.map((lines) => {
      const result: string[] = [];
      const comparator = options.comparator;

      if (!comparator) {
        // Fast O(n) path: use Set.has for equality check
        const seen = new Set<string>();
        for (const line of lines) {
          if (!seen.has(line)) {
            seen.add(line);
            result.push(line);
          }
        }
      } else {
        // Custom comparator path: O(n²) is unavoidable but isolated here
        const seen: string[] = [];
        for (const line of lines) {
          let isDuplicate = false;
          for (const existing of seen) {
            if (comparator(line, existing)) {
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) {
            seen.push(line);
            result.push(line);
          }
        }
      }

      return result;
    })
  );

export const dedupSimilar = (
  lines: string[],
  threshold: number = 0.8
): Effect.Effect<string[], ReadDedupError> =>
  Effect.succeed(lines).pipe(
    Effect.map((lines) => {
      const result: string[] = [];

      for (const line of lines) {
        let isSimilar = false;
        for (const existing of result) {
          const similarity = calculateSimilarity(line, existing);
          if (similarity >= threshold) {
            isSimilar = true;
            break;
          }
        }
        if (!isSimilar) {
          result.push(line);
        }
      }

      return result;
    })
  );

const calculateSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  const longerLength = longer.length;
  const editDistance = levenshteinDistance(longer, shorter);

  return (longerLength - editDistance) / longerLength;
};

const levenshteinDistance = (a: string, b: string): number => {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
};
