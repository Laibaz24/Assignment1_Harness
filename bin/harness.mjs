#!/usr/bin/env node
// Thin launcher: registers the TypeScript loader so plugins dropped into
// src/registry/** as .ts files are picked up on the next run without a build step.
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/core/cli.ts', import.meta.url).href);
