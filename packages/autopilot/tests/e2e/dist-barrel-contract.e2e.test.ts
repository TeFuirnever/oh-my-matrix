/**
 * E2E: published-package contract — what every host consumer depends on.
 *
 * dist/ is COMMITTED and is the artifact the OpenClaw host vendors. This suite
 * imports that committed dist AS-IS (no build step in the test) so a forgotten
 * rebuild+commit fails red here — exactly the drift we want to catch. It guards
 * the AutopilotProjection barrel export added in #25/#26 (hosts were
 * deep-importing dist/src/projection, coupling to internal layout).
 *
 * vitest strips types without checking them, so the type re-export is asserted
 * by reading the committed dist/index.d.ts source (a runtime string check),
 * not by a type-only import (which would be silently erased).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// dist/ is committed; this imports the vendored artifact — do not add a pre-build.
import * as autopilot from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dtsPath = resolve(here, '../../dist/index.d.ts');
const pkgPath = resolve(here, '../../package.json');
const dts = readFileSync(dtsPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main: string; types: string; name: string };

describe('E2E dist barrel contract — @oh-my-matrix/autopilot public surface', () => {
  it('package main/types point at the committed dist (so package-name import loads dist)', () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.name).toBe('@oh-my-matrix/autopilot');
  });

  it('committed dist/index.d.ts re-exports AutopilotProjection from the barrel (not a deep path)', () => {
    // The #25/#26 fix. If this line is dropped, host consumers that
    // `import type { AutopilotProjection } from '@oh-my-matrix/autopilot'` break.
    expect(dts).toContain('AutopilotProjection');
    expect(dts).toMatch(/export type \{ AutopilotProjection \}/);
  });

  it('runtime plugin manifest loads from committed dist', () => {
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
