/** Minimal dense linear algebra for the small (5x5) systems the preference model needs. */

export type Vec = number[];
export type Mat = number[][];

export const zeros = (n: number): Vec => new Array<number>(n).fill(0);

export const zerosMat = (n: number): Mat => Array.from({ length: n }, () => zeros(n));

export const diag = (v: readonly number[]): Mat => v.map((x, i) => v.map((_, j) => (i === j ? x : 0)));

export const addVec = (a: readonly number[], b: readonly number[]): Vec => a.map((x, i) => x + b[i]!);

export const scaleVec = (a: readonly number[], s: number): Vec => a.map((x) => x * s);

export const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, x, i) => sum + x * b[i]!, 0);

export const addMat = (a: Mat, b: Mat): Mat => a.map((row, i) => row.map((x, j) => x + b[i]![j]!));

export const scaleMat = (a: Mat, s: number): Mat => a.map((row) => row.map((x) => x * s));

export const outer = (a: readonly number[], b: readonly number[]): Mat => a.map((x) => b.map((y) => x * y));

export const matVec = (a: Mat, v: readonly number[]): Vec => a.map((row) => dot(row, v));

/** vT A v */
export const quadForm = (a: Mat, v: readonly number[]): number => dot(v, matVec(a, v));

/**
 * Cholesky factor L (lower triangular, A = L Lt) of a symmetric positive-definite matrix.
 * A tiny diagonal jitter is added if rounding makes the matrix marginally indefinite.
 */
export function cholesky(a: Mat): Mat {
  const n = a.length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const jitter = attempt === 0 ? 0 : 1e-10 * 10 ** attempt;
    const l = zerosMat(n);
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = a[i]![j]! + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
        if (i === j) {
          if (!(sum > 0)) {
            ok = false;
            break;
          }
          l[i]![j] = Math.sqrt(sum);
        } else {
          l[i]![j] = sum / l[j]![j]!;
        }
      }
    }
    if (ok) return l;
  }
  throw new Error('cholesky: matrix is not positive definite');
}

/** Solve A x = b for symmetric positive-definite A. */
export function solveSpd(a: Mat, b: readonly number[]): Vec {
  return solveWithFactor(cholesky(a), b);
}

function solveWithFactor(l: Mat, b: readonly number[]): Vec {
  const n = l.length;
  const y = zeros(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

/** Inverse of a symmetric positive-definite matrix. */
export function invertSpd(a: Mat): Mat {
  const n = a.length;
  const l = cholesky(a);
  const cols: Vec[] = [];
  for (let j = 0; j < n; j++) {
    const e = zeros(n);
    e[j] = 1;
    cols.push(solveWithFactor(l, e));
  }
  // cols[j] is column j; assemble and symmetrise against rounding.
  const inv = zerosMat(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) inv[i]![j] = (cols[j]![i]! + cols[i]![j]!) / 2;
  }
  return inv;
}
