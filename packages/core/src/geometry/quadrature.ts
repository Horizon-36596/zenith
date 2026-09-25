/**
 * Gauss-Legendre nodes and weights, computed once per order by Newton's method on the Legendre
 * polynomial. Deterministic and pure: the same order always yields the same numbers, so two runs
 * of `plan` on the same files agree to the last bit.
 */
export interface Quadrature {
  nodes: number[];
  weights: number[];
}

const cache = new Map<number, Quadrature>();

/** P_n(x) and its derivative, by the standard three-term recurrence. */
function legendre(n: number, x: number): { value: number; derivative: number } {
  let previous = 1;
  let current = x;
  for (let k = 2; k <= n; k += 1) {
    const next = ((2 * k - 1) * x * current - (k - 1) * previous) / k;
    previous = current;
    current = next;
  }
  if (n === 0) return { value: 1, derivative: 0 };
  const derivative = (n * (x * current - previous)) / (x * x - 1);
  return { value: current, derivative };
}

export function gaussLegendre(order: number): Quadrature {
  const cached = cache.get(order);
  if (cached !== undefined) return cached;
  const nodes: number[] = [];
  const weights: number[] = [];
  const half = Math.floor((order + 1) / 2);
  for (let i = 1; i <= half; i += 1) {
    // Chebyshev-like first guess, then Newton to machine precision.
    let x = Math.cos((Math.PI * (i - 0.25)) / (order + 0.5));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const { value, derivative } = legendre(order, x);
      const step = value / derivative;
      x -= step;
      if (Math.abs(step) < 1e-15) break;
    }
    const { derivative } = legendre(order, x);
    const weight = 2 / ((1 - x * x) * derivative * derivative);
    nodes.push(-x);
    weights.push(weight);
    if (i !== order - i + 1) {
      nodes.push(x);
      weights.push(weight);
    }
  }
  const quadrature: Quadrature = { nodes, weights };
  cache.set(order, quadrature);
  return quadrature;
}

/** Integrates f over [a, b] with an `order`-point Gauss-Legendre rule. */
export function integrate(f: (x: number) => number, a: number, b: number, order: number): number {
  const { nodes, weights } = gaussLegendre(order);
  const half = (b - a) / 2;
  const middle = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    sum += (weights[i] as number) * f(middle + half * (nodes[i] as number));
  }
  return sum * half;
}
