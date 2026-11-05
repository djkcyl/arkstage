import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateRelease({ versions, tag, signing, notes }) {
  const version = versions.package;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Invalid release version');
  for (const [name, value] of Object.entries(versions)) {
    if (value !== version) throw Error(`${name} version ${value} differs from ${version}`);
  }
  if (tag && tag !== `v${version}`) throw Error(`Tag ${tag} differs from package version ${version}`);
  if (signing.schemaVersion !== 1 || signing.packageName !== 'cn.aunly.arkstage'
    || !/^[a-f0-9]{64}$/.test(signing.certificateSha256) || !signing.keyAlias || !signing.firstSignedVersion) {
    throw Error('Invalid permanent Android signing policy');
  }
  if (!notes?.includes(`v${version}`)) throw Error('Missing release notes for this version');
  if (version === signing.firstSignedVersion && (!notes.includes('签名迁移') || !notes.includes('卸载'))) {
    throw Error('The initial signing migration must explain the required reinstall');
  }
  return version;
}

export function validateSignerContinuity(current, previous, version) {
  if (previous) {
    if (current.certificateSha256 !== previous.certificateSha256 || current.packageName !== previous.packageName) {
      throw Error('Signing identity differs from the previous published release; stop and plan an explicit migration');
    }
  } else if (version !== current.firstSignedVersion) {
    throw Error('Previous release has no signing manifest; only the documented initial migration may proceed');
  }
}

export function expectedReleaseAssets(version) {
  return [
    `Arkstage_${version}_aarch64.dmg`, 'Arkstage_aarch64.app.tar.gz',
    `Arkstage_${version}_x64.dmg`, 'Arkstage_x64.app.tar.gz',
    `Arkstage_${version}_amd64.deb`, `Arkstage-${version}-1.x86_64.rpm`,
    `Arkstage_${version}_x64-setup.exe`,
    `arkstage-v${version}-android-arm64-v8a.apk`,
    `arkstage-v${version}-android-arm64-v8a.apk.sha256`,
    `arkstage-v${version}-android-signing.json`,
  ];
}

export function validateAssets(assets, version) {
  for (const asset of assets) {
    if (asset.uploader?.login !== 'github-actions[bot]') throw Error(`Asset was not uploaded by Actions: ${asset.name}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw Error(`Missing server digest: ${asset.name}`);
    if (asset.size <= 0 || asset.state !== 'uploaded') throw Error(`Incomplete release asset: ${asset.name}`);
  }
  for (const name of expectedReleaseAssets(version)) {
    const matches = assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].size <= 0 || matches[0].state !== 'uploaded') {
      throw Error(`Missing or incomplete release asset: ${name}`);
    }
  }
}

export function readRelease(root) {
  const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const pkg = json('package.json'), lock = json('package-lock.json');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').split(/\n\[/)[0];
  const cargoApp = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8')
    .split('[[package]]').find(section => /^name = "app"$/m.test(section));
  return {
    versions: { package: pkg.version, npmLock: lock.version, npmRoot: lock.packages[''].version,
      tauri: json('src-tauri/tauri.conf.json').version,
      cargo: cargo.match(/^version = "([^"]+)"/m)?.[1], cargoLock: cargoApp?.match(/^version = "([^"]+)"/m)?.[1] },
    signing: json('config/android-signing.json'),
    notes: fs.readFileSync(path.join(root, `docs/releases/v${pkg.version}.md`), 'utf8'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const at = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const data = readRelease(root), version = validateRelease({ ...data, tag: at('--tag') });
  if (at('--assets-json')) {
    const raw = JSON.parse(fs.readFileSync(at('--assets-json'), 'utf8'));
    validateAssets(Array.isArray(raw) ? raw : raw.assets, version);
  }
  console.log(`Release v${version}: versions, notes and signing policy verified`);
}
