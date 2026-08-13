import { readFileSync } from 'fs';

/**
 * Refuse to build when `manifest.json` and `package.json` disagree about the version.
 *
 * This exists because of a real failure, not a hypothetical one. Two releases went out with
 * `package.json` bumped and `manifest.json` left behind, and the symptom was silence: the
 * host reads the **manifest**, so it went on reporting 0.0.12 and answering "nothing new"
 * while two versions' worth of work sat on `main`. Everything was pushed, everything was
 * correct, and the update button was right to do nothing.
 *
 * That is the shape worth guarding — not a build that breaks, but a build that succeeds and
 * ships something nobody can install. The two files have been in lockstep for every prior
 * release; nothing enforced it, so the first time it mattered it had already drifted.
 *
 * Wired into `prebuild`, so it runs on the one command that always precedes a release.
 */
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(
    `\nVersion mismatch — the host reads manifest.json, so this would install as ${manifest.version}:\n` +
      `  manifest.json  ${manifest.version}\n` +
      `  package.json   ${pkg.version}\n\n` +
      `Set both to the same value and build again.\n`
  );
  process.exit(1);
}
