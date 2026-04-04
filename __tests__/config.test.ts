import { describe, it, expect } from 'vitest';
import { loadConfig, getDefaultConfig } from '../src/config/index.js';
import { RiskLevel } from '../src/types.js';

describe('getDefaultConfig', () => {
  it('returns a config object with expected fields', () => {
    const cfg = getDefaultConfig();
    expect(cfg).toBeDefined();
    expect(cfg.thresholds).toBeDefined();
    expect(cfg.rules).toBeDefined();
    expect(cfg.scan).toBeDefined();
    expect(cfg.output).toBeDefined();
    expect(cfg.version).toBe(2);
  });

  it('has correct threshold defaults', () => {
    const cfg = getDefaultConfig();
    expect(cfg.thresholds.failOn).toBe(RiskLevel.High);
    expect(cfg.thresholds.guardOn).toBe(RiskLevel.Medium);
  });

  it('has empty disabled rules by default', () => {
    const cfg = getDefaultConfig();
    expect(cfg.rules.disabled).toEqual([]);
  });

  it('has scan configuration', () => {
    const cfg = getDefaultConfig();
    expect(cfg.scan.rootDir).toBe('.');
    expect(cfg.scan.extensions).toBeInstanceOf(Array);
    expect(cfg.scan.extensions.length).toBeGreaterThan(0);
    expect(cfg.scan.exclude).toBeInstanceOf(Array);
  });

  it('has output defaults', () => {
    const cfg = getDefaultConfig();
    expect(cfg.output.format).toBe('terminal');
    expect(cfg.output.color).toBe(true);
    expect(cfg.output.showRecommendations).toBe(true);
  });
});

describe('loadConfig', () => {
  it('falls back to defaults when no config file is present', () => {
    const cfg = loadConfig();
    expect(cfg.thresholds.failOn).toBe(RiskLevel.High);
    expect(cfg.thresholds.guardOn).toBe(RiskLevel.Medium);
    expect(cfg.version).toBe(2);
  });

  it('throws when pointing to a non-existent file', () => {
    expect(() => loadConfig('/non/existent/path.yml')).toThrow();
  });
});
