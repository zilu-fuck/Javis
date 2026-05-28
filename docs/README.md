# Javis Documentation

This directory collects product, architecture, security, and implementation
notes for Javis. The current target is a complete usable desktop product; the
MVP documents remain as baseline acceptance records.

## Start Here

- [Product Readiness](PRODUCT_READINESS.md): the current complete-product
  target, blockers, and gap matrix.
- [MVP Status](MVP_STATUS.md): completed MVP baseline and what it covers.
- [Development Guide](DEVELOPMENT.md): how to run, verify, and extend the
  project.
- [Troubleshooting](TROUBLESHOOTING.md): common local development, Tauri, and
  QA capture issues.
- [Security Model](SECURITY_MODEL.md): permission levels and filesystem safety
  rules used by the current implementation.
- [Manual QA Checklist](QA_CHECKLIST.md): desktop scenarios and screenshots to
  capture before release. See [QA Evidence](qa/README.md) for screenshot folder
  conventions.
- [Release Guide](RELEASE.md): build, QA evidence, and release note checklist.
- [Build/Sign/Release Runbook](BUILD_SIGN_RELEASE_RUNBOOK.md): step-by-step operational guide for producing a signed release.
- [Roadmap](ROADMAP.md): milestones toward complete product usability.

## Design And Reference Documents

- [Architecture](ARCHITECTURE.md)
- [Tech Stack](TECH_STACK.md)
- [Marvis Technical Support Notes](MARVIS_TECH_SUPPORT.md)
- [UI Layout](UI_LAYOUT.md)
- [MVP Specification](MVP.md)
- [Core Contracts](CORE_CONTRACTS.md)
- [Permissions and Safety](PERMISSIONS.md)
- [Project Structure](PROJECT_STRUCTURE.md)

The documents above should be normalized against `PRODUCT_READINESS.md`. If
behavior and design diverge, update `PRODUCT_READINESS.md`, `MVP_STATUS.md`
when the baseline changes, and the relevant reference document in the same
change.
