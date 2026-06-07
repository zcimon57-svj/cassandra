/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBootstrap } from "./bootstrap.mjs";

const centerRoot = path.resolve("../Mock-DBS-Skill");
const packageStore = path.join(centerRoot, "package-store/mock-file-store");

function tempRepo(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cassandra-bootstrap-${name}-`));
}

function writeConfig(repoRoot, overrides = {}) {
    const config = {
        schema_version: "repo-skill-config/v1",
        repo: "cassandra",
        engine: "taurus",
        agentcentor: {
            npm_scope: "@aimarket",
            registry: "file:///mock/aimarket/npm-registry",
            registry_config_key: "@aimarket:registry",
            cli_package: "@aimarket/agentcenter",
            package_store: {
                kind: "mock-file-store",
                reference: packageStore,
                used_by: "install"
            },
            bootstrap_market_command: "npm config set @aimarket:registry={registry} strict-ssl=false",
            skill_install_command_template: "npx {cli_package} skill add {agentcentor_skill}@{version} --client {client} --store {package_store}",
            client: "claudecode"
        },
        required_manifests: {
            department: path.join(centerRoot, "required/department.yml"),
            engine: path.join(centerRoot, "required/engine/taurus.yml"),
            repo: path.join(centerRoot, "required/repo/cassandra.yml"),
            access_mode: "anonymous",
            timeout_seconds: 10
        },
        paths: {
            repo_root: ".",
            install_root: ".claude/skill-bootstrap/plugins",
            skills_dir: ".claude/skills",
            plugin_dir: ".claude/skill-bootstrap/plugins",
            manifest: ".claude/skill-bootstrap/installed-plugins.json",
            session_context: ".claude/skill-bootstrap/session-context.json",
            cache_dir: ".claude/skill-bootstrap/cache",
            effective_required: ".claude/skill-bootstrap/cache/effective_required.json",
            install_report: ".claude/skill-bootstrap/install_report.json",
            managed_manifest: ".claude/skill-bootstrap/managed-files.json",
            validation_roots: [
                {
                    name: "skill_content",
                    path: ".claude/skills/rocksdb-review/SKILL.md",
                    required: true,
                    expected: "file"
                },
                {
                    name: "plugin_manifest",
                    path: ".claude/skill-bootstrap/plugins/rocksdb-review/.claude-plugin/plugin.json",
                    required: true,
                    expected: "file"
                },
                {
                    name: "activation_hook",
                    path: ".claude/skill-bootstrap/plugins/rocksdb-review/activation.yml",
                    required: true,
                    expected: "file"
                },
                {
                    name: "install_entry",
                    path: ".claude/skill-bootstrap/plugins/rocksdb-review/install-entry.md",
                    required: true,
                    expected: "file"
                }
            ]
        },
        policy: {
            allow_global_install: false,
            force_overwrite: false,
            configure_market_if_missing: true,
            required_main_tag: "dev",
            fail_open: true,
            install_timeout_seconds: 30,
            required_fetch_timeout_seconds: 10,
            host_mapping_only_on_dns_failure: true,
            dns_preflight: "warn_only",
            unknown_placeholder_policy: "reject_unknown"
        },
        ...overrides
    };
    fs.writeFileSync(path.join(repoRoot, "repo-skill-config.yml"), JSON.stringify(config, null, 2));
    return config;
}

function readJson(repoRoot, relativePath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function assertStartupDoesNotBlock(report) {
    for (const issue of [...report.warnings, ...report.blocking_errors]) {
        assert.equal(issue.blocks_claude_code_startup, false);
    }
}

test("installs active required skill from the configured mock file-store package store", async () => {
    const repoRoot = tempRepo("happy");
    writeConfig(repoRoot);

    const result = await runBootstrap({ repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(path.join(repoRoot, ".claude/skills/rocksdb-review/SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(repoRoot, ".claude/skill-bootstrap/plugins/rocksdb-review/.claude-plugin/plugin.json")), true);

    const effectiveRequired = readJson(repoRoot, ".claude/skill-bootstrap/cache/effective_required.json");
    assert.equal(effectiveRequired.schema_version, "effective-required/v1");
    assert.equal(effectiveRequired.repo, "cassandra");
    assert.equal(effectiveRequired.cache_source, "fresh");
    assert.equal(effectiveRequired.resolved_plugins[0].agentcentor_skill, "rocksdb-review");
    assert.equal(effectiveRequired.resolved_plugins[0].artifact_hash, "sha256:bc9735065d60fb2147b443efa96dc1cdd608f92c55fc6c9fa9973a22f3e132a6");

    const installReport = readJson(repoRoot, ".claude/skill-bootstrap/install_report.json");
    assert.equal(installReport.schema_version, "install-report/v1");
    assert.equal(installReport.status, "success");
    assert.match(installReport.rendered_command, /npx @aimarket\/agentcenter skill add rocksdb-review@3\.0\.10 --client claudecode/);
    assert.equal(installReport.validation.contains_manifest, true);
    assert.equal(installReport.validation.contains_skill, true);
    assert.equal(installReport.validation.contains_activation_or_hook, true);
    assert.equal(installReport.validation.install_entry_present, true);
    assertStartupDoesNotBlock(installReport);

    const installed = readJson(repoRoot, ".claude/skill-bootstrap/installed-plugins.json");
    assert.equal(installed.schema_version, "installed-plugins/v1");
    assert.equal(installed.plugins[0].status, "installed");

    const sessionContext = readJson(repoRoot, ".claude/skill-bootstrap/session-context.json");
    assert.equal(sessionContext.schema_version, "session-context/v1");
    assert.equal(sessionContext.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(sessionContext.hookSpecificOutput.reloadSkills, true);
});

test("uses cached required manifests when configured sources are unavailable", async () => {
    const repoRoot = tempRepo("cache");
    const config = writeConfig(repoRoot);
    await runBootstrap({ repoRoot });

    writeConfig(repoRoot, {
        required_manifests: {
            ...config.required_manifests,
            department: path.join(repoRoot, "missing/department.yml"),
            engine: path.join(repoRoot, "missing/engine.yml"),
            repo: path.join(repoRoot, "missing/repo.yml")
        }
    });

    const result = await runBootstrap({ repoRoot });
    const effectiveRequired = readJson(repoRoot, ".claude/skill-bootstrap/cache/effective_required.json");

    assert.equal(result.exitCode, 0);
    assert.equal(effectiveRequired.cache_source, "cached");
    assert.equal(effectiveRequired.resolved_plugins[0].agentcentor_skill, "rocksdb-review");
    assert.equal(effectiveRequired.warnings[0].blocks_claude_code_startup, false);
});

test("fails open and records non-startup-blocking issues when no cache is available", async () => {
    const repoRoot = tempRepo("failopen");
    writeConfig(repoRoot, {
        required_manifests: {
            department: path.join(repoRoot, "missing/department.yml"),
            engine: path.join(repoRoot, "missing/engine.yml"),
            repo: path.join(repoRoot, "missing/repo.yml"),
            access_mode: "anonymous",
            timeout_seconds: 10
        }
    });

    const result = await runBootstrap({ repoRoot });
    const effectiveRequired = readJson(repoRoot, ".claude/skill-bootstrap/cache/effective_required.json");
    const installReport = readJson(repoRoot, ".claude/skill-bootstrap/install_report.json");
    const sessionContext = readJson(repoRoot, ".claude/skill-bootstrap/session-context.json");

    assert.equal(result.exitCode, 0);
    assert.equal(effectiveRequired.cache_source, "empty_no_cache");
    assert.deepEqual(effectiveRequired.resolved_plugins, []);
    assert.equal(installReport.status, "skipped");
    assert.equal(sessionContext.hookSpecificOutput.reloadSkills, false);
    assertStartupDoesNotBlock(effectiveRequired);
    assertStartupDoesNotBlock(installReport);
});

test("does not overwrite a same-name local unmanaged skill", async () => {
    const repoRoot = tempRepo("conflict");
    writeConfig(repoRoot);
    const localSkillPath = path.join(repoRoot, ".claude/skills/rocksdb-review/SKILL.md");
    fs.mkdirSync(path.dirname(localSkillPath), { recursive: true });
    fs.writeFileSync(localSkillPath, "local unmanaged content\n");

    const result = await runBootstrap({ repoRoot });
    const installReport = readJson(repoRoot, ".claude/skill-bootstrap/install_report.json");
    const installed = readJson(repoRoot, ".claude/skill-bootstrap/installed-plugins.json");

    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(localSkillPath, "utf8"), "local unmanaged content\n");
    assert.equal(installReport.status, "skipped");
    assert.equal(installReport.warnings[0].code, "REQ_LOCAL_CONFLICT_SKIPPED");
    assert.equal(installReport.warnings[0].blocks_claude_code_startup, false);
    assert.equal(installed.plugins[0].status, "conflict_skipped");
});

test("does not overwrite an unmanaged plugin manifest landing path", async () => {
    const repoRoot = tempRepo("plugin-path-conflict");
    writeConfig(repoRoot);
    const unmanagedManifest = path.join(repoRoot, ".claude/skill-bootstrap/plugins/rocksdb-review/.claude-plugin/plugin.json");
    const unmanagedContent = "{\"unmanaged\":\"plugin manifest sentinel\"}\n";
    fs.mkdirSync(path.dirname(unmanagedManifest), { recursive: true });
    fs.writeFileSync(unmanagedManifest, unmanagedContent);

    const result = await runBootstrap({ repoRoot });
    const installReport = readJson(repoRoot, ".claude/skill-bootstrap/install_report.json");
    const installed = readJson(repoRoot, ".claude/skill-bootstrap/installed-plugins.json");

    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(unmanagedManifest, "utf8"), unmanagedContent);
    assert.match(installReport.status, /^(skipped|warning)$/);
    assert.equal(installReport.rendered_command, "");
    assert.equal(installReport.warnings[0].code, "REQ_LOCAL_CONFLICT_SKIPPED");
    assert.equal(installReport.warnings[0].blocks_claude_code_startup, false);
    assert.equal(installed.plugins[0].status, "conflict_skipped");
});

test("does not overwrite an unmanaged activation landing path", async () => {
    const repoRoot = tempRepo("activation-path-conflict");
    writeConfig(repoRoot);
    const unmanagedActivation = path.join(repoRoot, ".claude/skill-bootstrap/plugins/rocksdb-review/activation.yml");
    const unmanagedContent = "unmanaged: activation sentinel\n";
    fs.mkdirSync(path.dirname(unmanagedActivation), { recursive: true });
    fs.writeFileSync(unmanagedActivation, unmanagedContent);

    await runBootstrap({ repoRoot });
    const installReport = readJson(repoRoot, ".claude/skill-bootstrap/install_report.json");

    assert.equal(fs.readFileSync(unmanagedActivation, "utf8"), unmanagedContent);
    assert.match(installReport.status, /^(skipped|warning)$/);
    assert.equal(installReport.rendered_command, "");
    assert.equal(installReport.warnings[0].code, "REQ_LOCAL_CONFLICT_SKIPPED");
    assert.equal(installReport.warnings[0].blocks_claude_code_startup, false);
});
