# Setup paths and documentation corrections

## Goal

Make the release installer safe and verifiable, accurately describe Linux and source-deployment support, and make uninstall and Pi integration recovery match their documented behavior.

## 1. Safeguard release installation

Add regression coverage and update the curl installer so it replaces only Wolfpack-managed installation paths, always launches the newly installed binary for setup, and verifies both downloaded release artifacts against a published checksum manifest before replacement.

### 1a. Publish release integrity metadata

Extend the release workflow to produce and upload a checksum manifest covering each release binary that the installer consumes.

## 2. Clarify platform and source-deployment paths

Document that prebuilt release install and managed services support macOS and Linux, while the current `scripts/deploy-local.sh` workflow is macOS-only. Make that script reject unsupported hosts before build or mutation.

## 3. Make uninstall remove managed entrypoints

Add regression coverage and update uninstall to remove only installer-managed `wolfpack` symlinks while preserving unrelated executables, then correct full-removal documentation.

## 4. Make Pi setup messaging and recovery accurate

Correct the opt-in disclosure to name Wolfpack as the skill installer. Make a failed skill write leave no misleading partial destination when safe to clean up, with regression coverage and matching documentation.

## Non-goals

- Do not remove or overwrite an unrelated `wolfpack` executable.
- Do not add a Linux source-deployment implementation.
- Do not change broker lifecycle, session preservation, or the Pi Tasks package.
- Do not alter agent-skill content or non-Pi skill installation behavior.
