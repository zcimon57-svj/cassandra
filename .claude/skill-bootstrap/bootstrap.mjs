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

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ACTIVE_REQUIRED_INSTALLER = "session_start_bootstrap";
const INSTALL_TEMPLATE_PLACEHOLDERS = new Set([
    "cli_package",
    "agentcentor_skill",
    "version",
    "client",
    "package_store"
]);

function runId() {
    return `cassandra-bootstrap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
    return new Date().toISOString();
}

function issue(code, message, blocksExternalValidationPass, blocksActiveRequiredActivation) {
    return {
        code,
        message,
        blocks_external_validation_pass: blocksExternalValidationPass,
        blocks_active_required_activation: blocksActiveRequiredActivation,
        blocks_claude_code_startup: false
    };
}

function commonReport(schemaVersion, run, status = "success") {
    return {
        schema_version: schemaVersion,
        run_id: run,
        generated_at: now(),
        status,
        blocking_errors: [],
        warnings: []
    };
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function resolveRepoPath(repoRoot, value) {
    if (!value) return value;
    return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFile(source, target) {
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
}

function copyDir(source, target) {
    ensureDir(target);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyDir(sourcePath, targetPath);
        } else if (entry.isFile()) {
            copyFile(sourcePath, targetPath);
        }
    }
}

function listFiles(root) {
    if (!fs.existsSync(root)) return [];
    const result = [];
    function visit(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
            } else if (entry.isFile()) {
                result.push(path.relative(root, fullPath).replaceAll(path.sep, "/"));
            }
        }
    }
    visit(root);
    return result.sort();
}

function loadConfig(repoRoot) {
    const configPath = path.join(repoRoot, "repo-skill-config.yml");
    const text = fs.readFileSync(configPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
    return JSON.parse(text);
}

function parseYamlValue(rawValue) {
    const value = rawValue.trim();
    if (value === "") return "";
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "[]") return [];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function assignYamlPair(target, line) {
    const separator = line.indexOf(":");
    if (separator === -1) return;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (key === "plugins" && value.trim() === "") {
        target[key] = [];
        return;
    }
    target[key] = parseYamlValue(value);
}

function readRequiredManifest(file) {
    const manifest = { plugins: [] };
    let currentPlugin = null;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        if (line.startsWith("  - ")) {
            currentPlugin = {};
            manifest.plugins.push(currentPlugin);
            assignYamlPair(currentPlugin, line.slice(4));
        } else if (line.startsWith("    ") && currentPlugin) {
            assignYamlPair(currentPlugin, line.slice(4));
        } else if (!line.startsWith(" ")) {
            assignYamlPair(manifest, line);
        }
    }
    if (!Array.isArray(manifest.plugins)) manifest.plugins = [];
    return manifest;
}

function cacheFile(config, repoRoot, key) {
    return path.join(resolveRepoPath(repoRoot, config.paths.cache_dir), "required-manifests", `${key}.yml`);
}

function fetchRequiredManifests(config, repoRoot) {
    const manifests = [];
    const warnings = [];
    let anyFetchFailed = false;
    let usedCache = false;

    for (const key of ["department", "engine", "repo"]) {
        const source = config.required_manifests[key];
        const sourcePath = resolveRepoPath(repoRoot, source);
        const cachedPath = cacheFile(config, repoRoot, key);
        try {
            const manifest = readRequiredManifest(sourcePath);
            ensureDir(path.dirname(cachedPath));
            fs.copyFileSync(sourcePath, cachedPath);
            manifests.push({ key, source, manifest, cache_source: "fresh" });
        } catch (error) {
            anyFetchFailed = true;
            if (fs.existsSync(cachedPath)) {
                manifests.push({ key, source, manifest: readRequiredManifest(cachedPath), cache_source: "cached" });
                usedCache = true;
                warnings.push(issue("REQ_MANIFEST_FETCH_FAILED_CACHE_USED", `Failed to fetch ${key}; cached manifest used.`, false, false));
            } else {
                warnings.push(issue("REQ_MANIFEST_FETCH_FAILED_NO_CACHE", `Failed to fetch ${key}; no cache available.`, true, true));
            }
        }
    }

    let cacheSource = "fresh";
    if (usedCache) cacheSource = "cached";
    if (anyFetchFailed && manifests.length === 0) cacheSource = "empty_no_cache";
    return { manifests, warnings, cacheSource };
}

function sourceRank(entry) {
    if (entry.required_scope === "department") return 1;
    if ((entry.required_scope || "").startsWith("engine:")) return 2;
    if ((entry.required_scope || "").startsWith("repo:")) return 3;
    return 0;
}

function packageRecord(config, plugin) {
    const store = resolveRepoPath(process.cwd(), config.agentcentor.package_store.reference);
    const index = readJson(path.join(store, "index", `${plugin.agentcentor_skill}.json`));
    const record = index.versions[plugin.version];
    if (!record) {
        throw new Error(`No mock file-store record for ${plugin.agentcentor_skill}@${plugin.version}`);
    }
    const centerRoot = path.resolve(store, "../..");
    const packagePath = path.isAbsolute(record.artifact_path)
        ? record.artifact_path
        : path.resolve(centerRoot, record.artifact_path);
    return { ...record, packagePath };
}

function resolveRequired(config, repoRoot, fetched, run) {
    const report = {
        ...commonReport("effective-required/v1", run),
        repo: config.repo,
        engine: config.engine,
        sources: fetched.manifests.map((item) => ({
            key: item.key,
            source: item.source,
            cache_source: item.cache_source
        })),
        resolved_plugins: [],
        filtered_items: [],
        conflicts: [],
        cache_source: fetched.cacheSource
    };
    report.warnings.push(...fetched.warnings);

    const groups = new Map();
    for (const source of fetched.manifests) {
        for (const plugin of source.manifest.plugins || []) {
            const entry = { ...plugin, source_manifest: source.source };
            const group = groups.get(plugin.agentcentor_skill) || [];
            group.push(entry);
            groups.set(plugin.agentcentor_skill, group);
        }
    }

    for (const [skill, entries] of groups.entries()) {
        for (const entry of entries) {
            if (entry.status === "active" && entry.main_tag !== config.policy.required_main_tag) {
                report.filtered_items.push({ ...entry, reason: "REQ_NON_DEV_ACTIVE" });
                report.blocking_errors.push(issue("REQ_NON_DEV_ACTIVE", `${skill} is active but main_tag is not dev.`, true, true));
            } else if (entry.status !== "active") {
                report.filtered_items.push({ ...entry, reason: `REQ_${entry.status.toUpperCase()}_FILTERED` });
            }
        }

        const activeDev = entries.filter((entry) => entry.status === "active" && entry.main_tag === config.policy.required_main_tag);
        if (!activeDev.length) continue;

        activeDev.sort((left, right) => sourceRank(right) - sourceRank(left));
        const selected = activeDev[0];
        const versions = new Set(activeDev.map((entry) => entry.version));
        if (versions.size > 1) {
            const warning = issue("REQ_CONFLICT_RESOLVED", `${skill} active version conflict resolved by precedence.`, false, false);
            report.conflicts.push({
                ...warning,
                agentcentor_skill: skill,
                selected: {
                    version: selected.version,
                    required_scope: selected.required_scope
                },
                candidates: activeDev.map((entry) => ({
                    version: entry.version,
                    required_scope: entry.required_scope
                }))
            });
            report.warnings.push(warning);
        }

        let artifactHash = selected.artifact_hash || null;
        try {
            artifactHash = packageRecord(config, selected).artifact_hash;
        } catch (error) {
            report.warnings.push(issue("CLI_PACKAGE_INDEX_UNAVAILABLE", error.message, true, true));
        }

        report.resolved_plugins.push({
            agentcentor_skill: selected.agentcentor_skill,
            version: selected.version,
            required_scope: selected.required_scope,
            resolved_from: activeDev.map((entry) => entry.required_scope),
            main_tag: selected.main_tag,
            status: selected.status,
            artifact_hash: artifactHash
        });
    }

    report.status = report.blocking_errors.length ? "failed" : report.warnings.length ? "warning" : "success";
    return report;
}

function validationResult(config, repoRoot) {
    const roots = config.paths.validation_roots || [];
    const byName = new Map(roots.map((root) => [root.name, fs.existsSync(resolveRepoPath(repoRoot, root.path))]));
    return {
        contains_manifest: byName.get("plugin_manifest") === true,
        contains_skill: byName.get("skill_content") === true,
        contains_activation_or_hook: byName.get("activation_hook") === true,
        install_entry_present: byName.get("install_entry") === true
    };
}

function renderInstallCommand(config, plugin) {
    const template = config.agentcentor.skill_install_command_template;
    const unknown = [...template.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
        .filter((placeholder) => !INSTALL_TEMPLATE_PLACEHOLDERS.has(placeholder));
    if (unknown.length) {
        return {
            rendered: "",
            warning: issue("ADAPTER_UNKNOWN_PLACEHOLDER", `Unknown install placeholders: ${unknown.join(", ")}`, true, true)
        };
    }
    const rendered = template
        .replaceAll("{cli_package}", config.agentcentor.cli_package)
        .replaceAll("{agentcentor_skill}", plugin.agentcentor_skill)
        .replaceAll("{version}", plugin.version)
        .replaceAll("{client}", config.agentcentor.client)
        .replaceAll("{package_store}", config.agentcentor.package_store.reference);
    return { rendered };
}

function readInstalledManifest(config, repoRoot) {
    const manifestPath = resolveRepoPath(repoRoot, config.paths.manifest);
    if (!fs.existsSync(manifestPath)) return null;
    return readJson(manifestPath);
}

function managedEntryFor(config, repoRoot, plugin) {
    const manifest = readInstalledManifest(config, repoRoot);
    return (manifest?.plugins || []).find((entry) =>
        entry.agentcentor_skill === plugin.agentcentor_skill &&
        entry.installed_by === ACTIVE_REQUIRED_INSTALLER &&
        entry.status !== "conflict_skipped");
}

function localUnmanagedSkillPath(config, repoRoot, plugin) {
    return path.join(resolveRepoPath(repoRoot, config.paths.skills_dir), plugin.agentcentor_skill, "SKILL.md");
}

function relativeRepoPath(repoRoot, target) {
    return path.relative(repoRoot, target).replaceAll(path.sep, "/");
}

function isManagedTarget(repoRoot, target, managedEntry) {
    if (!managedEntry) return false;
    const managedFiles = new Set(managedEntry.managed_files || []);
    return managedFiles.has(relativeRepoPath(repoRoot, target));
}

function landingIntentForPackage(config, repoRoot, record) {
    const packageManifest = readJson(path.join(record.packagePath, ".claude-plugin", "plugin.json"));
    const pluginRoot = path.join(resolveRepoPath(repoRoot, config.paths.plugin_dir), packageManifest.agentcentor_skill);
    const targets = [];
    for (const file of listFiles(path.join(record.packagePath, ".claude-plugin"))) {
        targets.push(path.join(pluginRoot, ".claude-plugin", file));
    }
    targets.push(path.join(pluginRoot, packageManifest.activation.path));
    targets.push(path.join(pluginRoot, packageManifest.install_entry));
    for (const skill of packageManifest.skills || []) {
        const relativeSkillPath = skill.path.startsWith("skills/")
            ? skill.path.slice("skills/".length)
            : skill.path;
        targets.push(path.join(resolveRepoPath(repoRoot, config.paths.skills_dir), relativeSkillPath));
    }
    for (const root of config.paths.validation_roots || []) {
        targets.push(resolveRepoPath(repoRoot, root.path));
    }
    return {
        packageManifest,
        targets: [...new Set(targets.map((target) => path.resolve(target)))]
    };
}

function unmanagedLandingConflict(config, repoRoot, plugin, record) {
    const managedEntry = managedEntryFor(config, repoRoot, plugin);
    const localSkill = localUnmanagedSkillPath(config, repoRoot, plugin);
    if (fs.existsSync(localSkill) && !isManagedTarget(repoRoot, localSkill, managedEntry)) {
        return localSkill;
    }
    const { targets } = landingIntentForPackage(config, repoRoot, record);
    return targets.find((target) => fs.existsSync(target) && !isManagedTarget(repoRoot, target, managedEntry)) || null;
}

function installReportBase(config, run, plugin, renderedCommand, status = "success") {
    return {
        ...commonReport("install-report/v1", run, status),
        command_template_id: "skill_install_command_template",
        rendered_command: renderedCommand,
        exit_code: 0,
        agentcentor_skill: plugin?.agentcentor_skill || null,
        version: plugin?.version || null,
        artifact_hash: plugin?.artifact_hash || null,
        installed_files: [],
        validation: {
            contains_manifest: false,
            contains_skill: false,
            contains_activation_or_hook: false,
            install_entry_present: false
        },
        used_cache: false
    };
}

function writeInstalledManifest(config, repoRoot, run, plugins, status = "success") {
    const report = {
        ...commonReport("installed-plugins/v1", run, status),
        repo: config.repo,
        engine: config.engine,
        plugins
    };
    writeJson(resolveRepoPath(repoRoot, config.paths.manifest), report);
    return report;
}

function writeSessionContext(config, repoRoot, run, status, reloadSkills, warnings) {
    const warningCodes = warnings.map((warning) => warning.code);
    const reportPaths = [
        config.paths.effective_required,
        config.paths.install_report,
        config.paths.manifest,
        config.paths.session_context
    ];
    const context = {
        ...commonReport("session-context/v1", run, status),
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            reloadSkills,
            additionalContext: [
                `Cassandra required skill bootstrap status: ${status}.`,
                `Reports: ${reportPaths.join(", ")}.`,
                warningCodes.length ? `Warnings: ${warningCodes.join(", ")}.` : "Warnings: none."
            ].join(" ")
        },
        warnings_summary: warningCodes
    };
    context.warnings.push(...warnings);
    writeJson(resolveRepoPath(repoRoot, config.paths.session_context), context);
    return context;
}

function copyPackageToConfiguredPaths(config, repoRoot, record) {
    const packageManifest = readJson(path.join(record.packagePath, ".claude-plugin", "plugin.json"));
    const pluginRoot = path.join(resolveRepoPath(repoRoot, config.paths.plugin_dir), packageManifest.agentcentor_skill);
    copyDir(path.join(record.packagePath, ".claude-plugin"), path.join(pluginRoot, ".claude-plugin"));
    copyFile(path.join(record.packagePath, packageManifest.activation.path), path.join(pluginRoot, packageManifest.activation.path));
    copyFile(path.join(record.packagePath, packageManifest.install_entry), path.join(pluginRoot, packageManifest.install_entry));

    const managedFiles = [];
    for (const skill of packageManifest.skills || []) {
        const relativeSkillPath = skill.path.startsWith("skills/")
            ? skill.path.slice("skills/".length)
            : skill.path;
        const target = path.join(resolveRepoPath(repoRoot, config.paths.skills_dir), relativeSkillPath);
        copyFile(path.join(record.packagePath, skill.path), target);
        managedFiles.push(relativeRepoPath(repoRoot, target));
    }
    for (const file of listFiles(pluginRoot)) {
        managedFiles.push(relativeRepoPath(repoRoot, path.join(pluginRoot, file)));
    }
    return { packageManifest, managedFiles: managedFiles.sort() };
}

function installPlugin(config, repoRoot, run, plugin) {
    const record = packageRecord(config, plugin);
    const conflictPath = unmanagedLandingConflict(config, repoRoot, plugin, record);
    if (conflictPath) {
        const conflict = issue("REQ_LOCAL_CONFLICT_SKIPPED", `Local unmanaged landing path exists for ${plugin.agentcentor_skill}; install skipped without overwrite.`, true, true);
        const report = installReportBase(config, run, { ...plugin, artifact_hash: record.artifact_hash }, "", "skipped");
        report.warnings.push(conflict);
        writeJson(resolveRepoPath(repoRoot, config.paths.install_report), report);
        writeInstalledManifest(config, repoRoot, run, [{
            agentcentor_skill: plugin.agentcentor_skill,
            version: plugin.version,
            old_version: null,
            new_version: null,
            required_scope: plugin.required_scope,
            installed_by: ACTIVE_REQUIRED_INSTALLER,
            status: "conflict_skipped",
            stale_reason: "local_unmanaged_conflict",
            managed_files: [],
            validation: report.validation
        }], "warning");
        return { report, changed: false, warnings: [conflict] };
    }

    const { rendered, warning } = renderInstallCommand(config, plugin);
    if (warning) {
        const report = installReportBase(config, run, plugin, rendered, "skipped");
        report.warnings.push(warning);
        writeJson(resolveRepoPath(repoRoot, config.paths.install_report), report);
        writeInstalledManifest(config, repoRoot, run, [], "warning");
        return { report, changed: false, warnings: [warning] };
    }

    const { packageManifest, managedFiles } = copyPackageToConfiguredPaths(config, repoRoot, record);
    const validation = validationResult(config, repoRoot);
    const report = installReportBase(config, run, { ...plugin, artifact_hash: record.artifact_hash }, rendered, "success");
    report.installed_files = managedFiles;
    report.validation = validation;
    if (!Object.values(validation).every(Boolean)) {
        report.status = "failed";
        report.exit_code = 4;
        report.blocking_errors.push(issue("CLI_INSTALL_VALIDATION_FAILED", "Installed package landing validation failed.", true, true));
    }
    writeJson(resolveRepoPath(repoRoot, config.paths.install_report), report);

    writeInstalledManifest(config, repoRoot, run, [{
        agentcentor_skill: plugin.agentcentor_skill,
        version: plugin.version,
        old_version: null,
        new_version: plugin.version,
        required_scope: plugin.required_scope,
        installed_by: ACTIVE_REQUIRED_INSTALLER,
        status: report.status === "success" ? "installed" : "install_failed",
        stale_reason: null,
        managed_files: managedFiles,
        validation
    }], report.status);
    writeJson(resolveRepoPath(repoRoot, config.paths.managed_manifest), {
        schema_version: "bootstrap-managed-files/v1",
        run_id: run,
        generated_at: now(),
        agentcentor_skill: packageManifest.agentcentor_skill,
        version: packageManifest.version,
        managed_files: managedFiles
    });
    return { report, changed: report.status === "success", warnings: report.warnings };
}

function writeSkippedInstall(config, repoRoot, run, warnings) {
    const report = installReportBase(config, run, null, "", "skipped");
    report.warnings.push(...warnings);
    writeJson(resolveRepoPath(repoRoot, config.paths.install_report), report);
    writeInstalledManifest(config, repoRoot, run, [], warnings.length ? "warning" : "skipped");
    return report;
}

export async function runBootstrap(options = {}) {
    const repoRoot = path.resolve(options.repoRoot || process.cwd());
    const originalCwd = process.cwd();
    const run = runId();
    process.chdir(repoRoot);
    try {
        const config = loadConfig(repoRoot);
        const fetched = fetchRequiredManifests(config, repoRoot);
        const effectiveRequired = resolveRequired(config, repoRoot, fetched, run);
        writeJson(resolveRepoPath(repoRoot, config.paths.effective_required), effectiveRequired);

        const allWarnings = [...effectiveRequired.warnings, ...effectiveRequired.blocking_errors];
        let installResult;
        if (!effectiveRequired.resolved_plugins.length) {
            installResult = {
                report: writeSkippedInstall(config, repoRoot, run, allWarnings),
                changed: false,
                warnings: allWarnings
            };
        } else {
            installResult = installPlugin(config, repoRoot, run, effectiveRequired.resolved_plugins[0]);
            allWarnings.push(...installResult.warnings);
        }
        writeSessionContext(config, repoRoot, run, installResult.report.status, installResult.changed, allWarnings);
        return { exitCode: 0, runId: run };
    } catch (error) {
        try {
            const config = loadConfig(repoRoot);
            const bootstrapIssue = issue("BOOTSTRAP_FAIL_OPEN", `Bootstrap failed open: ${error.message}`, true, true);
            writeSkippedInstall(config, repoRoot, run, [bootstrapIssue]);
            writeSessionContext(config, repoRoot, run, "warning", false, [bootstrapIssue]);
        } catch {
            // SessionStart must fail open even when report paths are unavailable.
        }
        return { exitCode: 0, runId: run };
    } finally {
        process.chdir(originalCwd);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const repoRootFlag = process.argv.indexOf("--repo-root");
    const repoRoot = repoRootFlag === -1 ? process.cwd() : process.argv[repoRootFlag + 1];
    runBootstrap({ repoRoot }).then((result) => {
        process.exit(result.exitCode);
    }, () => {
        process.exit(0);
    });
}
