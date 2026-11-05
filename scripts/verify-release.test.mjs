import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRelease, validateSignerContinuity, expectedReleaseAssets, validateAssets, readRelease } from './verify-release.mjs';
import { fileURLToPath } from 'node:url';
const signing = { schemaVersion: 1, packageName: 'cn.aunly.arkstage', keyAlias: 'release', certificateSha256: 'a'.repeat(64), firstSignedVersion: '1.3.1' };
const input = { versions: { package: '1.3.1', tauri: '1.3.1', cargo: '1.3.1' }, tag: 'v1.3.1', signing, notes: 'v1.3.1 签名迁移：卸载旧版后安装。' };
const assets = () => expectedReleaseAssets('1.3.1').map(name => ({ name, size: 123, state: 'uploaded', digest: `sha256:${'b'.repeat(64)}`, uploader: { login: 'github-actions[bot]' } }));

test('release rejects mismatched versions, tags and undocumented signing migration', () => {
  assert.equal(validateRelease(input), '1.3.1');
  assert.throws(() => validateRelease({ ...input, versions: { ...input.versions, cargo: '1.3.0' } }), /version/);
  assert.throws(() => validateRelease({ ...input, tag: 'v1.3.2' }), /Tag/);
  assert.throws(() => validateRelease({ ...input, notes: 'v1.3.1 ordinary changes' }), /migration/);
});
test('subsequent releases cannot silently change or lose the established signer', () => {
  validateSignerContinuity(signing, null, '1.3.1');
  validateSignerContinuity(signing, signing, '1.3.2');
  assert.throws(() => validateSignerContinuity(signing, null, '1.3.2'), /no signing manifest/);
  assert.throws(() => validateSignerContinuity({ ...signing, certificateSha256: 'c'.repeat(64) }, signing, '1.3.2'), /identity differs/);
});
test('publication requires every platform, complete APK, checksum and public signer manifest', () => {
  validateAssets(assets(), '1.3.1');
  for (const missing of expectedReleaseAssets('1.3.1')) {
    assert.throws(() => validateAssets(assets().filter(asset => asset.name !== missing), '1.3.1'), /Missing/);
  }
  const empty = assets(); empty[0].size = 0; assert.throws(() => validateAssets(empty, '1.3.1'), /[Ii]ncomplete/);
});
test('manual uploads and missing server digests cannot pass the publication gate', () => {
  const manual = assets(); manual[7].uploader.login = 'someone'; assert.throws(() => validateAssets(manual, '1.3.1'), /not uploaded by Actions/);
  const noDigest = assets(); delete noDigest[7].digest; assert.throws(() => validateAssets(noDigest, '1.3.1'), /Missing server digest/);
});
test('the repository itself satisfies the same preflight checks used by Actions', () => {
  const data = readRelease(fileURLToPath(new URL('../', import.meta.url)));
  validateRelease({ ...data, tag: `v${data.versions.package}` });
});
