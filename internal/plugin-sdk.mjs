import assert from "node:assert/strict";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const CAPABILITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export class CapabilityRegistry {
  #entries = new Map();

  register(name, version, value, providerId) {
    assertCapabilityName(name);
    assertSemanticVersion(version, `capability ${name}`);
    if (this.#entries.has(name)) {
      throw new Error(`capability ${name} is already available`);
    }
    this.#entries.set(name, Object.freeze({ name, version, value, providerId }));
  }

  unregisterProvider(providerId) {
    for (const [name, entry] of this.#entries) {
      if (entry.providerId === providerId) this.#entries.delete(name);
    }
  }

  require(name, range = "*") {
    const entry = this.#entries.get(name);
    if (!entry) throw new Error(`capability ${name} is not available`);
    if (!satisfiesVersion(entry.version, range)) {
      throw new Error(`capability ${name} ${entry.version} does not satisfy ${range}`);
    }
    return entry.value;
  }

  optional(name, range = "*") {
    if (!this.#entries.has(name)) return undefined;
    return this.require(name, range);
  }
}

export class PluginHost {
  constructor() {
    this.capabilities = new CapabilityRegistry();
    this.active = [];
    this.disposed = false;
  }

  async activate(definitions) {
    if (this.active.length > 0) throw new Error("plugin host is already active");
    if (this.disposed) throw new Error("plugin host is disposed");

    const ordered = resolveActivationOrder(definitions);
    let current = null;
    try {
      for (const definition of ordered) {
        const access = createCapabilityAccess(definition.manifest, this.capabilities);
        const cleanups = [];
        let acceptingCleanups = true;
        const defer = (cleanup) => {
          assert.equal(typeof cleanup, "function", `plugin ${definition.manifest.id} cleanup must be a function`);
          assert.ok(acceptingCleanups, `plugin ${definition.manifest.id} cannot defer cleanup after activation`);
          cleanups.push(cleanup);
          return cleanup;
        };
        current = { id: definition.manifest.id, cleanups };
        let activation;
        try {
          activation = await definition.activate(Object.freeze({
            plugin: definition.manifest,
            capabilities: access,
            defer,
          })) ?? {};
        } finally {
          acceptingCleanups = false;
        }
        if (typeof activation.dispose === "function") cleanups.push(activation.dispose);
        const provided = activation.capabilities ?? {};
        validateProvidedCapabilities(definition.manifest, provided);
        for (const [name, version] of Object.entries(definition.manifest.provides)) {
          this.capabilities.register(name, version, provided[name], definition.manifest.id);
        }
        this.active.push(current);
        current = null;
      }
    } catch (error) {
      const rollbackErrors = [];
      if (current) {
        this.capabilities.unregisterProvider(current.id);
        rollbackErrors.push(...await disposeCleanups(current.cleanups));
      }
      rollbackErrors.push(...await this.#drainActive());
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `plugin activation failed: ${error?.message ?? error}; rollback also failed`,
          { cause: error },
        );
      }
      throw error;
    }
    return this;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.#disposeActive();
  }

  async #disposeActive() {
    const errors = await this.#drainActive();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "multiple plugin cleanup operations failed");
  }

  async #drainActive() {
    const errors = [];
    while (this.active.length > 0) {
      const plugin = this.active.pop();
      try {
        errors.push(...await disposeCleanups(plugin.cleanups));
      } finally {
        this.capabilities.unregisterProvider(plugin.id);
      }
    }
    return errors;
  }
}

async function disposeCleanups(cleanups) {
  const errors = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function definePlugin(definition) {
  assert.equal(typeof definition?.activate, "function", "plugin activate must be a function");
  const manifest = validateManifest(definition.manifest);
  return Object.freeze({ manifest, activate: definition.activate });
}

export function validateManifest(input) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "plugin manifest is required");
  assert.match(input.id ?? "", PLUGIN_ID_PATTERN, "plugin id must be lowercase and stable");
  assertSemanticVersion(input.version, `plugin ${input.id}`);
  const provides = validateCapabilityMap(input.provides, "provides", { ranges: false });
  const requires = validateCapabilityMap(input.requires, "requires", { ranges: true });
  const optional = validateCapabilityMap(input.optional, "optional", { ranges: true });
  for (const name of Object.keys(requires)) {
    assert.ok(!(name in optional), `capability ${name} cannot be both required and optional`);
  }
  const permissions = input.permissions ?? [];
  assert.ok(Array.isArray(permissions), "plugin permissions must be an array");
  assert.ok(permissions.every((permission) => typeof permission === "string" && permission.length > 0),
    "plugin permissions must contain non-empty strings");
  return Object.freeze({
    id: input.id,
    version: input.version,
    provides: Object.freeze(provides),
    requires: Object.freeze(requires),
    optional: Object.freeze(optional),
    permissions: Object.freeze([...permissions]),
  });
}

export function satisfiesVersion(version, range) {
  const current = parseVersion(version);
  if (range === "*" || range === undefined) return true;
  if (SEMVER_PATTERN.test(range)) return compareVersions(current, parseVersion(range)) === 0;

  const majorWildcard = /^(0|[1-9]\d*)\.x$/.exec(range);
  if (majorWildcard) return current.major === Number(majorWildcard[1]);

  if (range.startsWith("^")) {
    const minimum = parseVersion(range.slice(1));
    const upper = minimum.major > 0
      ? { major: minimum.major + 1, minor: 0, patch: 0 }
      : minimum.minor > 0
        ? { major: 0, minor: minimum.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: minimum.patch + 1 };
    return compareVersions(current, minimum) >= 0 && compareVersions(current, upper) < 0;
  }
  throw new Error(`unsupported semantic version range ${range}`);
}

function resolveActivationOrder(definitions) {
  assert.ok(Array.isArray(definitions), "plugin definitions must be an array");
  const plugins = new Map();
  const providers = new Map();

  for (const definition of definitions) {
    assert.ok(definition?.manifest && typeof definition.activate === "function", "invalid plugin definition");
    const manifest = validateManifest(definition.manifest);
    if (plugins.has(manifest.id)) throw new Error(`duplicate plugin id ${manifest.id}`);
    plugins.set(manifest.id, definition);
    for (const [name, version] of Object.entries(manifest.provides)) {
      if (providers.has(name)) {
        throw new Error(`capability ${name} is provided by both ${providers.get(name).id} and ${manifest.id}`);
      }
      providers.set(name, { id: manifest.id, version });
    }
  }

  const dependencies = new Map([...plugins.keys()].map((id) => [id, new Set()]));
  for (const definition of plugins.values()) {
    const { manifest } = definition;
    for (const [name, range] of Object.entries(manifest.requires)) {
      const provider = providers.get(name);
      if (!provider || !satisfiesVersion(provider.version, range)) {
        const found = provider ? ` (found ${provider.version})` : "";
        throw new Error(`plugin ${manifest.id} requires ${name} ${range}${found}`);
      }
      dependencies.get(manifest.id).add(provider.id);
    }
    for (const [name, range] of Object.entries(manifest.optional)) {
      const provider = providers.get(name);
      if (!provider) continue;
      if (!satisfiesVersion(provider.version, range)) {
        throw new Error(`plugin ${manifest.id} optional capability ${name} requires ${range} (found ${provider.version})`);
      }
      dependencies.get(manifest.id).add(provider.id);
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`plugin dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(plugins.get(id));
  };
  for (const id of plugins.keys()) visit(id);
  return ordered;
}

function createCapabilityAccess(manifest, registry) {
  return Object.freeze({
    require(name) {
      const range = manifest.requires[name];
      if (!range) throw new Error(`plugin ${manifest.id} did not declare required capability ${name}`);
      return registry.require(name, range);
    },
    optional(name) {
      const range = manifest.optional[name];
      if (!range) throw new Error(`plugin ${manifest.id} did not declare optional capability ${name}`);
      return registry.optional(name, range);
    },
  });
}

function validateProvidedCapabilities(manifest, provided) {
  assert.ok(provided && typeof provided === "object" && !Array.isArray(provided),
    `plugin ${manifest.id} capabilities must be an object`);
  const expected = Object.keys(manifest.provides).sort();
  const actual = Object.keys(provided).sort();
  assert.deepEqual(actual, expected, `plugin ${manifest.id} provided capabilities do not match its manifest`);
  for (const name of expected) {
    assert.notEqual(provided[name], undefined, `plugin ${manifest.id} did not provide ${name}`);
  }
}

function validateCapabilityMap(input, label, { ranges }) {
  const map = input ?? {};
  assert.ok(map && typeof map === "object" && !Array.isArray(map), `plugin ${label} must be an object`);
  const result = {};
  for (const [name, version] of Object.entries(map)) {
    assertCapabilityName(name);
    if (ranges) {
      satisfiesVersion("0.0.0", version);
    } else {
      assertSemanticVersion(version, `capability ${name}`);
    }
    result[name] = version;
  }
  return result;
}

function assertCapabilityName(name) {
  assert.match(name ?? "", CAPABILITY_ID_PATTERN, "capability id must be lowercase and stable");
}

function assertSemanticVersion(version, label) {
  assert.match(version ?? "", SEMVER_PATTERN, `${label} must use a semantic version`);
}

function parseVersion(version) {
  assertSemanticVersion(version, "version");
  const [, major, minor, patch] = SEMVER_PATTERN.exec(version);
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
