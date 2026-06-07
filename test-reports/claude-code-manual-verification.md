# Claude Code Manual Verification Notes

## Current Automated Evidence

Selected repo:

```text
/home/cimon/code/skill-management-validation-repos/cassandra
```

Latest observed bootstrap run:

```text
cassandra-bootstrap-1780746945354-3a140d40ecaa8
```

Verified automatically:

* `SessionStart` hook runs when `claude -p` starts in the repo root.
* `session-context.json`, `effective_required.json`, `install_report.json`,
  and `installed-plugins.json` share the latest run id.
* Required skill `rocksdb-review@3.0.10` is installed with
  `install_report.status: success` and `exit_code: 0`.
* Installed files exist, including `.claude/skills/rocksdb-review/SKILL.md`.
* `session-context.json.hookSpecificOutput.reloadSkills` is `true`.
* `session-context.json.hookSpecificOutput.additionalContext` is non-empty.
* Explicit slash invocation resolves without `--plugin-dir`:
  `/rocksdb-review`.

Not verified automatically:

* The Claude Code plugin manager does not list `rocksdb-review` as an installed
  plugin.
* The generic near-trigger prompt did not show skill-specific guidance.
* The no-edit real-development prompt did not show skill-specific guidance.
* No Prompt skill adoption proof is available or should be claimed.

## Manual Interactive Check

Run from the Cassandra repo root:

```bash
cd /home/cimon/code/skill-management-validation-repos/cassandra
claude
```

In the interactive session, check these items:

1. Confirm startup does not fail.
2. Ask Claude Code whether a `rocksdb-review` skill or slash command is
   available.
3. Try explicit invocation:

   ```text
   /rocksdb-review
   ```

4. Send a near-trigger prompt without explicit slash invocation:

   ```text
   Review a small RocksDB storage-engine change involving compaction, flush,
   recovery, and iterator behavior. Tell me what specialized review checklist
   you would apply.
   ```

5. Send a low-risk real-development prompt:

   ```text
   Draft a test-plan-only checklist for a storage-engine review. Do not edit
   repository files.
   ```

Record results using these states:

```text
observed_true | emitted_only | no_effect | unstable | not_observed | not_applicable
```

Manual pass criteria for visibility:

* `/rocksdb-review` resolves or appears in an available skill/slash-command
  surface.

Manual pass criteria for near-trigger:

* The near-trigger prompt shows RocksDB review guidance without explicit slash
  invocation.

Language guard:

```text
no Prompt skill adoption proof
```

Even if the manual near-trigger check succeeds, record it only as visibility or
near-trigger observation. Do not describe it as model adoption proof.
