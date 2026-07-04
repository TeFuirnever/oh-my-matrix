/**
 * E2E: published-package contract — what every host consumer depends on.
 *
 * dist/ is NOT committed (see ADR-015) — it is regenerated from source by the
 * CI `pnpm -r build` step before tests run. This suite imports that freshly
 * built dist to verify the published-package barrel contract: the runtime
 * manifest + the AutopilotProjection type re-export added in #25/#26 (hosts
 * were deep-importing dist/src/projection, coupling to internal layout).
 *
 * vitest strips types without checking them, so the type re-export is asserted
 * by reading the built dist/index.d.ts source (a runtime string check), not by
 * a type-only import (which would be silently erased).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// dist/ is built by CI; this imports the freshly built artifact.
import * as autopilot from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dtsPath = resolve(here, '../../dist/index.d.ts');
const pkgPath = resolve(here, '../../package.json');
const dts = readFileSync(dtsPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main: string; types: string; name: string };

describe('E2E dist barrel contract — @oh-my-matrix/autopilot public surface', () => {
  it('package main/types point at dist (so package-name import loads dist)', () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.name).toBe('@oh-my-matrix/autopilot');
  });

  it('built dist/index.d.ts re-exports AutopilotProjection from the barrel (not a deep path)', () => {
    // The #25/#26 fix. If this line is dropped, host consumers that
    // `import type { AutopilotProjection } from '@oh-my-matrix/autopilot'` break.
    expect(dts).toContain('AutopilotProjection');
    expect(dts).toMatch(/export type \{ AutopilotProjection \}/);
  });

  it('runtime plugin manifest loads from built dist', () => {
    expect(autopilot.id).toBe('autopilot');
    expect(autopilot.name).toBe('Autopilot Continuous Mode');
    expect(typeof autopilot.version).toBe('string');
    expect(autopilot.version.length).toBeGreaterThan(0);
    expect(typeof autopilot.register).toBe('function');
  });

  it('projectState is NOT part of the public runtime surface (internal-only)', () => {
    // projectState is used internally to build the projection; only the
    // AutopilotProjection TYPE is public. Pinning this keeps the surface tight.
    expect((autopilot as { projectState?: unknown }).projectState).toBeUndefined();
  });
});
