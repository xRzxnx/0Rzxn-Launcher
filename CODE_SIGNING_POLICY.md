# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Status: application pending.** The project has applied to SignPath Foundation. Until it is accepted, releases are built
> by GitHub Actions but are **not signed**, and Windows SmartScreen may ask for confirmation (**More info → Run anyway**).
> This page will say so when the first signed release is out.

## What is signed

- The Windows installer `0Rzxn_-Launcher-Setup-<version>.exe` attached to each [GitHub release](https://github.com/xRzxnx/0Rzxn-Launcher/releases).
- The launcher executable `0Rzxn_ Launcher.exe` inside it.

Only files built from this repository are signed. Upstream files bundled unchanged (Electron and its libraries) keep
their original state. The Windows publisher shown for signed files is **SignPath Foundation**.

## How releases are built

- Every release is built from the `main` branch by the [Release workflow](.github/workflows/release.yml) on GitHub-hosted
  runners, never on a personal computer.
- The workflow runs the tests, type checks, lint and translation checks, builds the installer, submits it to SignPath,
  checks it on [VirusTotal](https://www.virustotal.com) and only then publishes the release. The VirusTotal report is
  linked at the end of each release's notes.
- Each signing request is approved by hand by an approver (below).
- Installed launchers only accept updates signed with the same certificate once the first signed version is installed.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [xRzxnx](https://github.com/xRzxnx) |
| Approvers | [xRzxnx](https://github.com/xRzxnx) |

All members use multi-factor authentication on GitHub and SignPath. Changes from anyone else are reviewed by a committer
before they are merged.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or
the person installing or operating it.

To do what the user asks, the launcher talks only to:

- Mojang and Microsoft services: game files, Java runtimes, Microsoft sign-in, Xbox Live and Minecraft profile services.
- The mod loader projects the user chooses (Fabric, Quilt, Forge, NeoForge) to install them.
- [Modrinth](https://modrinth.com) when the user searches, installs or checks mods and modpacks.
- GitHub, to look for launcher updates (can be turned off in Settings › Launcher).
- [mclo.gs](https://mclo.gs), only when the user clicks to share a game log.

There is no telemetry, no analytics and no advertising. Sign-in tokens are stored encrypted by Windows on the user's PC
and are only sent to Microsoft, Xbox Live and Minecraft services. See [Microsoft sign-in and privacy](README.md#microsoft-sign-in-and-privacy).
